import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpServer, McpSchema } from "effect/ai";
import * as McpHttpServer from "../../McpHttpServer.ts";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as GoalHandlers from "./handlers.ts";
import * as GoalMcpService from "../../GoalMcpService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { GoalToolkit } from "./tools.ts";

const PARENT = ThreadId.make("thread:parent");
const CHILD = ThreadId.make("thread:child");
const GOAL_ID = CommandId.make("command:goal");
const CODEX = ProviderInstanceId.make("codex");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const shell = (fields: Partial<OrchestrationV2ThreadShell>) => ({
  ...liveThreadShell(fields.id ?? CHILD),
  ...fields,
});

const childShell = (callerId = CHILD) =>
  shell({
    id: callerId,
    goalIteration: { parentThreadId: PARENT, goalId: GOAL_ID, iteration: 2 },
  });

const parentShell = (currentChildThreadId: ThreadId | null) =>
  shell({
    id: PARENT,
    goal: { objective: "Native provider task", status: "active", tokensUsed: 10 },
    t3Goal: {
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
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(GoalHandlers.layer).pipe(
        Layer.provide(GoalMcpService.layer),
        Layer.provide(dependencies),
      ),
    ),
  );
  const server = yield* McpServer.McpServer.pipe(
    Effect.provide(
      McpHttpServer.layerGoalToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(dependencies),
      ),
    ),
  );
  const client = McpSchema.McpServerClient.of({
    clientId: 1,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
    clientInfo: { name: "goal-test", version: "1" },
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "goal-test", version: "1" },
    },
    getClient: Effect.die("unused"),
  });
  const call = <Name extends keyof typeof GoalToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scopeOverrides: Partial<McpInvocationContext.McpInvocationScope> = {},
  ) =>
    server.callTool({ name, arguments: params }).pipe(
      Effect.map(
        (result) =>
          result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text),
      ),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        requestNamespace: "provider-session-1",
        thread: {
          threadId: options.caller.id,
          providerSessionId: "provider-session-1",
          providerInstanceId: CODEX,
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
        issuedAt: 1,
        ...scopeOverrides,
      }),
      Effect.provide(GoalMcpService.layer.pipe(Layer.provideMerge(dependencies))),
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

it.effect(
  "allows reports in restricted/plan mode but refuses ended, missing-capability and client callers",
  () =>
    Effect.gen(function* () {
      const restricted = yield* makeHarness({
        caller: { ...childShell(), runtimeMode: "approval-required", interactionMode: "plan" },
        parent: parentShell(CHILD),
      });
      expect(yield* restricted.call("t3_goal_update", { note: "Progress" })).toEqual({
        iteration: 2,
        recorded: true,
      });
      expect(
        yield* restricted.call("t3_goal_update", { note: "Denied" }, { capabilities: new Set() }),
      ).toMatchObject({ code: "capability_denied" });
      expect(
        yield* restricted.call(
          "t3_goal_update",
          { note: "Outside" },
          {
            thread: undefined,
            client: { sessionId: "client", label: "Outside", access: "full-access" },
          },
        ),
      ).toMatchObject({ code: "thread_credential_required" });
      const ended = yield* makeHarness({
        caller: { ...childShell(), activeRunId: null },
        parent: parentShell(CHILD),
      });
      expect(
        yield* ended.call("t3_goal_complete", { status: "complete", summary: "Late" }),
      ).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(restricted.commands)).toHaveLength(1);
      expect(yield* Ref.get(ended.commands)).toHaveLength(0);
    }),
);

it.effect("proposes only descriptive state and rejects blank reports/proposals", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ caller: shell({ id: PARENT }), parent: null });
    expect(
      yield* harness.call("t3_goal_propose", {
        objective: "  Ship  ",
        doneWhen: "  Tests pass  ",
        background: "context",
        preApprovedActions: "Local edits",
        minutesPerIteration: 60,
      }),
    ).toEqual({ proposed: true });
    expect(yield* Ref.get(harness.commands)).toMatchObject([
      {
        type: "thread.goal.propose",
        threadId: PARENT,
        objective: "Ship",
        doneWhen: "Tests pass",
        permissions: "Local edits",
        iterationTimeoutMins: 60,
        checkCommand: null,
      },
    ]);
    expect(yield* harness.call("t3_goal_update", { note: "   " })).toMatchObject({
      code: "invalid_request",
    });
    expect(
      yield* harness.call("t3_goal_propose", { objective: "   ", doneWhen: "Pass" }),
    ).toMatchObject({ code: "invalid_request" });
    expect(yield* Ref.get(harness.commands)).toHaveLength(1);
  }),
);

it.effect("does not treat a provider-native goal as the T3 owner and refuses deleted owners", () =>
  Effect.gen(function* () {
    for (const parent of [
      shell({
        id: PARENT,
        t3Goal: null,
        goal: { objective: "Native provider task", status: "active", tokensUsed: 10 },
      }),
      { ...parentShell(CHILD), deletedAt: parentShell(CHILD).createdAt },
    ]) {
      const harness = yield* makeHarness({ caller: childShell(), parent });
      expect(
        yield* harness.call("t3_goal_complete", { status: "complete", summary: "Done" }),
      ).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(harness.commands)).toHaveLength(0);
    }
  }),
);
