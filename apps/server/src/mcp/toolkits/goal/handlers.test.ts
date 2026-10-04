import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { GoalHandlersLive } from "./handlers.ts";
import { GoalToolkit } from "./tools.ts";

const PARENT = ThreadId.make("thread:parent");
const CHILD = ThreadId.make("thread:child");
const GOAL_ID = CommandId.make("command:goal");
const CODEX = ProviderInstanceId.make("codex");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const shell = (fields: Partial<OrchestrationV2ThreadShell>) =>
  ({
    providerInstanceId: CODEX,
    archivedAt: null,
    deletedAt: null,
    activeRunId: RunId.make("run:child"),
    ...fields,
  }) as OrchestrationV2ThreadShell;

const childShell = (callerId = CHILD) =>
  shell({
    id: callerId,
    goalIteration: { parentThreadId: PARENT, goalId: GOAL_ID, iteration: 2 },
  });

const parentShell = (currentChildThreadId: ThreadId | null) =>
  shell({
    id: PARENT,
    goal: {
      id: GOAL_ID,
      objective: "Ship it",
      status: "active",
      statusReason: null,
      iteration: 2,
      tokensUsed: 0,
      needsInput: false,
      currentChildThreadId,
    },
  });

const makeHarness = Effect.fn("makeGoalToolkitHarness")(function* (options: {
  readonly caller: OrchestrationV2ThreadShell;
  readonly parent: OrchestrationV2ThreadShell | null;
}) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === options.caller.id
            ? options.caller
            : threadId === PARENT
              ? options.parent
              : null,
        ),
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* GoalToolkit.pipe(
    Effect.provide(GoalHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof GoalToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: options.caller.id,
        providerSessionId: "provider-session-1",
        providerInstanceId: CODEX,
        capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

describe("goal toolkit handlers", () => {
  it.effect("reports into the parent goal from the current iteration", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ caller: childShell(), parent: parentShell(CHILD) });
      expect(yield* harness.call("t3_goal_update", { note: "  Parser done  " })).toEqual({
        iteration: 2,
        recorded: true,
      });
      yield* harness.call("t3_goal_complete", { status: "blocked", summary: "Need a key" });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.goal.report",
          threadId: PARENT,
          goalId: GOAL_ID,
          iteration: 2,
          childThreadId: CHILD,
          report: { type: "note", text: "Parser done" },
        },
        { report: { type: "claim", status: "blocked", summary: "Need a key" } },
      ]);
    }),
  );

  it.effect("refuses a stale iteration and threads outside a goal", () =>
    Effect.gen(function* () {
      const stale = yield* makeHarness({
        caller: childShell(),
        parent: parentShell(ThreadId.make("thread:newer-child")),
      });
      expect(yield* stale.call("t3_goal_update", { note: "late" })).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "invalid_request",
      });
      expect(yield* Ref.get(stale.commands)).toEqual([]);

      const plain = yield* makeHarness({ caller: shell({ id: PARENT }), parent: null });
      expect(
        yield* plain.call("t3_goal_complete", { status: "complete", summary: "Done" }),
      ).toMatchObject({ code: "invalid_request" });
    }),
  );
});
