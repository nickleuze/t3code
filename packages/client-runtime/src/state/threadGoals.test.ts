import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type AuthSessionState,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("goal-host");
const other = EnvironmentId.make("other-host");
const input = {
  type: "thread.goal.set" as const,
  commandId: CommandId.make("start"),
  threadId: ThreadId.make("owner"),
  objective: "Ship",
  doneWhen: "Tests pass",
};
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});

const harness = Effect.fnUntraced(function* (supports = true) {
  const sent: OrchestrationV2Command[] = [];
  const supervisor = {
    target: { environmentId: env },
    session: yield* SubscriptionRef.make(
      Option.some({
        initialConfig: Effect.succeed({
          environment: { environmentId: env, capabilities: { t3Goals: supports } },
        }),
        client: {
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
            Effect.sync(() => {
              sent.push(command);
              return { sequence: sent.length };
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, {
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (n) => new Uint8Array(n),
          digest: (_a, d) => Effect.succeed(d),
        }),
      ),
    ),
  );
  const commands = createThreadEnvironmentAtoms(runtime, () => Atom.make(null));
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  registry.mount(sessions(other));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return { commands, registry, sent };
});

describe("guarded T3 goal commands", () => {
  it.effect("requires the destination grant and preserves the exact command identity", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.registry.set(sessions(env), AsyncResult.success(grant(true)));
      h.registry.set(sessions(other), AsyncResult.success(grant(false)));
      expect(h.registry.get(h.commands.setGoal.permissionAtom(env))).toBe(true);
      expect(h.registry.get(h.commands.setGoal.permissionAtom(other))).toBe(false);
      expect(
        (yield* Effect.promise(() =>
          h.commands.setGoal.run(h.registry, { environmentId: other, input }),
        ))._tag,
      ).toBe("Failure");
      expect(h.sent).toEqual([]);
      expect(
        (yield* Effect.promise(() =>
          h.commands.setGoal.run(h.registry, { environmentId: env, input }),
        ))._tag,
      ).toBe("Success");
      expect(h.sent).toEqual([input]);
      h.registry.set(sessions(env), AsyncResult.success(grant(false)));
      expect(
        (yield* Effect.promise(() =>
          h.commands.controlGoal.run(h.registry, {
            environmentId: env,
            input: {
              type: "thread.goal.control",
              commandId: CommandId.make("stop"),
              threadId: input.threadId,
              goalId: input.commandId,
              action: "stop",
            },
          }),
        ))._tag,
      ).toBe("Failure");
      expect(h.sent).toEqual([input]);
    }),
  );
  it.effect("refuses a downgraded host even when its grant is valid", () =>
    Effect.gen(function* () {
      const h = yield* harness(false);
      h.registry.set(sessions(env), AsyncResult.success(grant(true)));
      expect(
        (yield* Effect.promise(() =>
          h.commands.setGoal.run(h.registry, { environmentId: env, input }),
        ))._tag,
      ).toBe("Failure");
      expect(h.sent).toEqual([]);
    }),
  );
  it.effect("sends replies and proposal dismissal through the same guarded seam", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.registry.set(sessions(env), AsyncResult.success(grant(true)));
      yield* Effect.promise(() =>
        h.commands.messageGoal.run(h.registry, {
          environmentId: env,
          input: {
            type: "thread.goal.message",
            commandId: CommandId.make("reply"),
            threadId: input.threadId,
            goalId: input.commandId,
            text: "Use the candidate",
          },
        }),
      );
      yield* Effect.promise(() =>
        h.commands.dismissGoalProposal.run(h.registry, {
          environmentId: env,
          input: {
            type: "thread.goal.proposal.dismiss",
            commandId: CommandId.make("dismiss"),
            threadId: input.threadId,
            proposalId: CommandId.make("proposal"),
          },
        }),
      );
      expect(h.sent.map((c) => c.type)).toEqual([
        "thread.goal.message",
        "thread.goal.proposal.dismiss",
      ]);
    }),
  );
});
