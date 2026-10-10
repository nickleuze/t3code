import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";

const env = EnvironmentId.make("goal-host");
const input = {
  type: "thread.goal.set" as const,
  commandId: CommandId.make("start"),
  threadId: ThreadId.make("owner"),
  objective: "Ship",
  doneWhen: "Tests pass",
};
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
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return { commands, registry, sent };
});

describe("T3 goal commands", () => {
  it.effect("dispatch the exact command to a host that supports goals", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const control = {
        type: "thread.goal.control" as const,
        commandId: CommandId.make("stop"),
        threadId: input.threadId,
        goalId: input.commandId,
        action: "stop" as const,
      };
      const reply = {
        type: "thread.goal.message" as const,
        commandId: CommandId.make("reply"),
        threadId: input.threadId,
        goalId: input.commandId,
        text: "Use the candidate",
      };
      const dismiss = {
        type: "thread.goal.proposal.dismiss" as const,
        commandId: CommandId.make("dismiss"),
        threadId: input.threadId,
        proposalId: CommandId.make("proposal"),
      };
      for (const result of [
        yield* Effect.promise(() =>
          h.commands.setGoal.run(h.registry, { environmentId: env, input }),
        ),
        yield* Effect.promise(() =>
          h.commands.controlGoal.run(h.registry, { environmentId: env, input: control }),
        ),
        yield* Effect.promise(() =>
          h.commands.messageGoal.run(h.registry, { environmentId: env, input: reply }),
        ),
        yield* Effect.promise(() =>
          h.commands.dismissGoalProposal.run(h.registry, { environmentId: env, input: dismiss }),
        ),
      ])
        expect(result._tag).toBe("Success");
      expect(h.sent).toEqual([input, control, reply, dismiss]);
    }),
  );
  it.effect("refuses a host without T3 goals before sending", () =>
    Effect.gen(function* () {
      const h = yield* harness(false);
      expect(
        (yield* Effect.promise(() =>
          h.commands.setGoal.run(h.registry, { environmentId: env, input }),
        ))._tag,
      ).toBe("Failure");
      expect(h.sent).toEqual([]);
    }),
  );
});
