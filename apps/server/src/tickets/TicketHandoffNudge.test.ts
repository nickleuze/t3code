import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionRecords } from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Tickets from "./TicketService.ts";
import * as Nudge from "./TicketHandoffNudge.ts";

it.effect(
  "nudge fires once per tool-using turn, skips chat, existing entries and its own follow-up",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("work");
      let runId = RunId.make("tools");
      let interactionMode = "plan";
      let items = [{ type: "dynamic_tool", runId }];
      let messages: { role: string; text: string }[] = [];
      const dispatched: OrchestrationV2ServerCommand[] = [];
      let threadReads = 0;
      const ticketLayer = Tickets.layer.pipe(
        Layer.provide(Projects.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Sqlite.layerMemory),
      );
      const dependencies = Layer.mergeAll(
        ticketLayer,
        Settings.layerTest(),
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(0),
          stream: () => Stream.empty,
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (() =>
            Effect.sync(() => {
              threadReads++;
              return {
                thread: { id: threadId, archivedAt: null, deletedAt: null, interactionMode },
                runs: [
                  {
                    id: runId,
                    startedAt: DateTime.makeUnsafe(0),
                    completedAt: DateTime.makeUnsafe(1_000),
                  },
                ],
                turnItems: items,
                messages,
              } as unknown as ProjectionRecords<"runs" | "turnItems" | "messages">;
            })) as Orchestrator.OrchestratorV2["Service"]["getThreadRecords"],
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 0, storedEvents: [] };
            }),
        }),
      );
      const context = yield* Layer.build(dependencies);
      const tickets = yield* Tickets.TicketService.pipe(Effect.provideContext(context));
      const { ticket } = yield* tickets.upsert({ title: "Nudge" });
      yield* tickets.link({ id: ticket.id, threadId, role: "planning" });
      const nudge = yield* Nudge.make.pipe(Effect.provideContext(context));
      yield* nudge.observe({ id: RunId.make("unlinked"), threadId: ThreadId.make("unlinked") });
      yield* nudge.drain;
      assert.equal(threadReads, 0);
      assert.equal(dispatched.length, 0);
      yield* nudge.observe({ id: runId, threadId });
      yield* nudge.drain;
      assert.equal(dispatched.length, 0);
      interactionMode = "default";
      yield* nudge.observe({ id: runId, threadId });
      yield* nudge.drain;
      yield* nudge.observe({ id: runId, threadId });
      yield* nudge.drain;
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]?.type, "message.dispatch");
      runId = RunId.make("chat");
      items = [];
      yield* nudge.observe({ id: runId, threadId });
      yield* nudge.drain;
      assert.equal(dispatched.length, 1);
      runId = RunId.make("entry");
      items = [{ type: "dynamic_tool", runId }];
      yield* tickets.entry(
        { id: ticket.id, kind: "progress", text: "Recorded" },
        tickets.author({ actor: "agent", thread: threadId }),
      );
      yield* nudge.observe({ id: runId, threadId });
      yield* nudge.drain;
      assert.equal(dispatched.length, 1);
      runId = RunId.make("nudge-follow-up");
      items = [{ type: "dynamic_tool", runId }];
      messages = [
        { role: "user", text: "Automatic ticket handoff request from T3 Code: Write a handoff" },
      ];
      yield* nudge.observe({ id: runId, threadId });
      yield* nudge.drain;
      assert.equal(dispatched.length, 1);
    }),
);

it("chat-only turns and disabled reminders do not qualify", () => {
  const base = {
    enabled: true,
    thread: ThreadId.make("work"),
    machine: "A",
    startedAt: "2026-10-12T00:00:00.000Z",
    completedAt: "2026-10-12T00:00:01.000Z",
    events: [],
    isNudgeTurn: false,
  };
  assert.isFalse(Nudge.needsTicketHandoff({ ...base, items: [{ type: "assistant_message" }] }));
  assert.isFalse(
    Nudge.needsTicketHandoff({
      ...base,
      items: [
        {
          type: "command_execution",
          id: TurnItemId.make(
            "turn-item:provider:codex:native-item:workspace-preparation%3Arun%3A1",
          ),
        },
      ],
    }),
  );
  assert.isFalse(
    Nudge.needsTicketHandoff({ ...base, enabled: false, items: [{ type: "dynamic_tool" }] }),
  );
});

it("plan, read-only and terminal records never get a write nudge", () => {
  const base = {
    enabled: true,
    thread: ThreadId.make("work"),
    machine: "A",
    startedAt: "2026-10-12T00:00:00.000Z",
    completedAt: "2026-10-12T00:00:01.000Z",
    events: [],
    items: [{ type: "dynamic_tool" as const }],
    isNudgeTurn: false,
  };
  assert.isTrue(Nudge.needsTicketHandoff(base));
  for (const excluded of [
    { interactionMode: "plan" },
    { readOnly: true },
    { stage: "done" },
    { stage: "dropped" },
  ])
    assert.isFalse(Nudge.needsTicketHandoff({ ...base, ...excluded }));
});

it("native read-only sandbox forms suppress the handoff write", () => {
  for (const policy of [
    "read-only",
    { type: "read-only" },
    { type: "readOnly", networkAccess: true },
  ])
    assert.isTrue(Nudge.ticketPolicyReadOnly(policy));
  for (const policy of [undefined, null, "workspace-write", { type: "workspaceWrite" }])
    assert.isFalse(Nudge.ticketPolicyReadOnly(policy));
});
