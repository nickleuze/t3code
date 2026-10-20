import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  RunId,
  ThreadId,
  TicketError,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2TurnItem,
  type TicketEvent,
} from "@t3tools/contracts";
import { ticketStartPrompt } from "@t3tools/shared/ticket";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionRecords } from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Outcomes from "./TicketPlanOutcome.ts";
import * as Tickets from "./TicketService.ts";

const threadId = ThreadId.make("planning-thread");
const runId = RunId.make("planning-run");
const startedAt = DateTime.makeUnsafe(20_000);
const completedAt = DateTime.makeUnsafe(30_000);

// Only the external orchestration read boundary is simulated. Ticket writes,
// timestamps, retry receipts, rebuilds and the recovery cursor use real SQLite.
const harness = Effect.gen(function* () {
  yield* TestClock.setTime(10_000);
  const context = yield* Layer.build(
    Tickets.layer.pipe(
      Layer.provideMerge(Projects.layer),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  );
  const tickets = yield* Tickets.TicketService.pipe(Effect.provideContext(context));
  const sql = yield* SqlClient.SqlClient.pipe(Effect.provideContext(context));
  const { ticket } = yield* tickets.upsert({ title: "Plan the change", status: "in_progress" });
  yield* tickets.link({ id: ticket.id, threadId, role: "work" });
  const run = {
    id: runId,
    threadId,
    startedAt,
    completedAt: null,
    modelSelection: { model: "provider-neutral" },
    status: "running",
  } as OrchestrationV2Run;
  const stored = (sequence: number, type: string, payload: unknown): OrchestrationV2StoredEvent =>
    ({
      sequence,
      commandId: CommandId.make(`command:${sequence}`),
      event: { type, threadId, payload },
    }) as OrchestrationV2StoredEvent;
  const state = {
    history: [
      stored(1, "thread.created", { interactionMode: "plan" }),
      stored(2, "run.created", { ...run, status: "queued", startedAt: null }),
      stored(3, "run.updated", run),
    ],
    sources: [
      {
        type: "proposed_plan",
        id: "plan-item",
        runId,
        markdown: "private plan prose",
        streaming: false,
      },
      {
        type: "assistant_message",
        id: "answer-item",
        runId,
        text: "corrected premise and needed decision",
      },
      { type: "user_input_request", id: "question-item", runId, questions: [] },
      { type: "reasoning", id: "private-reasoning", runId, text: "never copy" },
    ] as OrchestrationV2TurnItem[],
    deleted: false,
    archived: false,
    reads: 0,
    failAfterWrite: false,
  };
  const sink = Layer.mock(EventSink.EventSinkV2)({
    latestSequence: () => Effect.sync(() => state.history.at(-1)?.sequence ?? 0),
    stream: (input) =>
      Stream.fromIterable(
        state.history.filter(
          (event) =>
            event.sequence > (input?.afterSequence ?? 0) && event.event.type === input?.eventType,
        ),
      ),
  });
  const events = Layer.mock(EventStore.EventStoreV2)({
    read: (input) =>
      Stream.fromIterable(
        state.history.filter(
          (event) =>
            event.sequence <= (input?.throughSequence ?? Infinity) &&
            event.event.type === input?.eventType,
        ),
      ),
  });
  const orchestration = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadRecords: ((_id, _fields, filter) =>
      Effect.sync(() => {
        state.reads++;
        assert.equal(filter?.turnItemRunId, runId);
        assert.deepStrictEqual(filter?.turnItemTypes, [
          "proposed_plan",
          "assistant_message",
          "user_input_request",
        ]);
        return {
          thread: {
            id: threadId,
            deletedAt: state.deleted ? completedAt : null,
            archivedAt: state.archived ? completedAt : null,
            interactionMode: "default",
          },
          turnItems: state.sources,
        } as unknown as ProjectionRecords<"turnItems">;
      })) as Orchestrator.OrchestratorV2["Service"]["getThreadRecords"],
    dispatch: () => Effect.die("Planning bookkeeping must never dispatch provider work"),
  });
  const make = Outcomes.make.pipe(
    Effect.provide(Layer.mergeAll(sink, events, orchestration)),
    Effect.provideService(Tickets.TicketService, {
      ...tickets,
      entry: (...args) =>
        tickets.entry(...args).pipe(
          Effect.flatMap((result) => {
            if (!state.failAfterWrite) return Effect.succeed(result);
            state.failAfterWrite = false;
            return Effect.fail(new TicketError({ message: "Simulated interruption after commit" }));
          }),
        ),
    }),
    Effect.provideContext(context),
  );
  const finish = (status: OrchestrationV2Run["status"] = "completed", sequence = 4) => {
    const event = stored(sequence, "run.updated", { ...run, status, completedAt });
    state.history.push(event);
    return event;
  };
  const entries = tickets
    .timeline({ id: ticket.id })
    .pipe(Effect.map(({ events }) => events.filter((e) => e.type === "entry")));
  return { tickets, sql, ticket, state, make, finish, stored, entries };
});

it.effect.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
  "records a $status planning outcome with source pointers and no write powers",
  (status) =>
    Effect.gen(function* () {
      const h = yield* harness;
      const worker = yield* h.make;
      h.finish(status);
      yield* worker.run;
      const [entry] = yield* h.entries;
      assert.equal(entry?.kind, "note");
      assert.equal(entry?.at, DateTime.formatIso(completedAt));
      assert.include(entry!.text, `run ${status}`);
      for (const id of [
        "plan-item",
        "answer-item",
        "question-item",
        "planning-run",
        "t3-thread://v1/planning-thread",
      ])
        assert.include(entry!.text, id);
      for (const excluded of [
        "private plan prose",
        "corrected premise and needed decision",
        "private-reasoning",
        "never copy",
      ])
        assert.notInclude(entry!.text, excluded);
      assert.include(entry!.text, "not acceptance of scope or permission to implement");
      assert.isString(entry?.next);
      const current = (yield* h.tickets.get(h.ticket.id)).ticket;
      assert.equal(current.status, "in_progress");
      assert.isFalse(current.workState?.resultReady);
      assert.deepStrictEqual(current.workState?.decisions, []);
      assert.equal(current.workState?.nextAction?.text, entry?.next);
      assert.equal(current.workState?.currentEvidence?.eventId, entry?.eventId);
    }),
);

it.effect("preserves blockers, authored handoffs and their structured next", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const worker = yield* h.make;
    yield* TestClock.setTime(25_000);
    const by = h.tickets.author({ actor: "agent", thread: threadId });
    yield* h.tickets.entry(
      {
        id: h.ticket.id,
        kind: "handoff",
        text: "Measured scope; Nick chose the narrow option",
        next: "Nick decides whether to implement",
      },
      by,
    );
    // Even this thread's own blocker must survive the automatic record.
    yield* h.tickets.entry(
      {
        id: h.ticket.id,
        kind: "blocker",
        text: "Need a measurement",
        next: "Nick provides the measurement",
      },
      by,
    );
    h.finish("failed");
    yield* worker.run;
    const current = (yield* h.tickets.get(h.ticket.id)).ticket;
    assert.isTrue(current.workState?.blocked);
    assert.equal(current.workState?.nextAction?.text, "Nick provides the measurement");
    assert.isUndefined((yield* h.entries).at(-1)?.next);
  }),
);

it.effect.each([true, false])(
  "retains an authored handoff beside the source note (structured next: %s)",
  (structured) =>
    Effect.gen(function* () {
      const h = yield* harness;
      const worker = yield* h.make;
      yield* TestClock.setTime(25_000);
      yield* h.tickets.entry(
        {
          id: h.ticket.id,
          kind: "handoff",
          text:
            "Corrected premise: the migration already ran. Scope is validation only." +
            (structured ? "" : "\nNext: Nick decides whether validation is sufficient"),
          ...(structured ? { next: "Nick decides whether validation is sufficient" } : {}),
        },
        h.tickets.author({ actor: "agent", thread: threadId }),
      );
      h.finish();
      yield* worker.run;
      const prompt = ticketStartPrompt((yield* h.tickets.get(h.ticket.id)).ticket);
      assert.include(prompt, "Corrected premise: the migration already ran");
      assert.include(prompt, "planning-run");
      assert.include(prompt, "Nick decides whether validation is sufficient");
      assert.isUndefined((yield* h.entries).at(-1)?.next);
    }),
);

it.effect("starts prospectively and recovers a missed outcome once after restart and rebuild", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.finish("completed"); // Old history exists before activation.
    const first = yield* h.make;
    yield* first.run;
    assert.lengthOf(yield* h.entries, 0);
    h.finish("interrupted", 5); // Missed after activation, before the next stream.
    const restarted = yield* h.make;
    yield* restarted.run;
    assert.lengthOf(yield* h.entries, 1);
    yield* h.tickets.rebuild;
    yield* (yield* h.make).run;
    assert.lengthOf(yield* h.entries, 1);
    assert.equal(
      (yield* h.sql<{ sequence: number }>`SELECT sequence FROM fork_ticket_plan_outcome_cursor`)[0]
        ?.sequence,
      5,
    );
  }),
);

it.effect("a crash after commit retries the same entry before advancing the cursor", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const worker = yield* h.make;
    h.finish();
    h.state.failAfterWrite = true;
    yield* worker.run.pipe(Effect.flip);
    assert.lengthOf(yield* h.entries, 1);
    assert.equal(
      (yield* h.sql<{ sequence: number }>`SELECT sequence FROM fork_ticket_plan_outcome_cursor`)[0]
        ?.sequence,
      3,
    );
    yield* (yield* h.make).run;
    assert.lengthOf(yield* h.entries, 1);
    assert.equal(
      (yield* h.sql<{ sequence: number }>`SELECT sequence FROM fork_ticket_plan_outcome_cursor`)[0]
        ?.sequence,
      4,
    );
  }),
);

it.effect(
  "partial multi-ticket delivery retries without duplicates or losing the second record",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const second = (yield* h.tickets.upsert({ title: "Second", status: "ready" })).ticket;
      yield* h.tickets.link({ id: second.id, threadId, role: "planning" });
      const worker = yield* h.make;
      h.finish();
      h.state.failAfterWrite = true;
      yield* worker.run.pipe(Effect.flip);
      yield* (yield* h.make).run;
      for (const id of [h.ticket.id, second.id])
        assert.lengthOf(
          (yield* h.tickets.timeline({ id })).events.filter((e) => e.type === "entry"),
          1,
        );
    }),
);

it.effect(
  "recovery keeps source ordering across a newer decision and accepted/reopened cycle",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const worker = yield* h.make;
      h.finish();
      yield* TestClock.setTime(40_000);
      yield* h.tickets.upsert({ id: h.ticket.id, status: "done" });
      yield* TestClock.setTime(50_000);
      yield* h.tickets.upsert({ id: h.ticket.id, status: "ready" });
      yield* h.tickets.entry({
        id: h.ticket.id,
        kind: "decision",
        text: "New accepted scope",
        next: "Run the new verification",
      });
      yield* worker.run;
      const current = (yield* h.tickets.get(h.ticket.id)).ticket;
      assert.equal(current.workState?.currentEvidence?.text, "New accepted scope");
      assert.equal(current.workState?.nextAction?.text, "Run the new verification");
      assert.equal(current.status, "ready");
      assert.lengthOf(yield* h.entries, 2);
      yield* h.tickets.rebuild;
      assert.deepStrictEqual((yield* h.tickets.get(h.ticket.id)).ticket, current);
    }),
);

it.effect.each([
  "done",
  "dropped",
  "deleted",
  "origin",
  "unlinked",
  "remote",
  "late-link",
] as const)("does not capture %s work", (excluded) =>
  Effect.gen(function* () {
    const h = yield* harness;
    const worker = yield* h.make;
    if (excluded === "done" || excluded === "dropped")
      yield* h.tickets.upsert({ id: h.ticket.id, status: excluded });
    else if (excluded === "deleted") h.state.deleted = true;
    else {
      const original = (yield* h.tickets.timeline({ id: h.ticket.id })).events.find(
        (e) => e.type === "link",
      )!;
      yield* h.tickets.unlink({ id: h.ticket.id, threadId });
      if (excluded === "late-link") yield* TestClock.setTime(40_000);
      if (excluded === "remote" && original.type === "link")
        yield* h.tickets.importEvents([
          {
            ...original,
            eventId: "ZZZ-remote",
            machine: "elsewhere",
            by: { actor: "agent", machine: "elsewhere" },
          },
        ]);
      else if (excluded !== "unlinked")
        yield* h.tickets.reference({
          id: h.ticket.id,
          kind: "thread",
          ref: threadId,
          role: excluded === "origin" ? "origin" : "work",
        });
    }
    h.finish();
    yield* worker.run;
    assert.lengthOf(yield* h.entries, 0);
  }),
);

it.effect.each(["plan", "default"] as const)(
  "uses $mode at start despite mode changes during and after the run",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.state.history[0] = h.stored(1, "thread.created", { interactionMode: mode });
      const worker = yield* h.make;
      h.state.history.push(
        h.stored(4, "thread.interaction-mode-updated", {
          interactionMode: mode === "plan" ? "default" : "plan",
        }),
      );
      h.finish("completed", 5);
      yield* worker.run;
      assert.lengthOf(yield* h.entries, mode === "plan" ? 1 : 0);
    }),
);

it.effect("uses the mode at start rather than when the run was queued", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const starting = h.state.history.pop()!;
    h.state.history.push(
      h.stored(3, "thread.interaction-mode-updated", { interactionMode: "default" }),
      {
        ...starting,
        sequence: 4,
      },
    );
    const worker = yield* h.make;
    h.finish("completed", 5);
    yield* worker.run;
    assert.lengthOf(yield* h.entries, 0);
  }),
);

it.effect.each(["plan", "default"] as const)(
  "uses the composer mode %s set before a new run, ahead of older title metadata",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* harness;
      const earlier = mode === "plan" ? "default" : "plan";
      h.state.history = [
        h.stored(1, "thread.created", { interactionMode: earlier }),
        h.stored(2, "thread.metadata-updated", { interactionMode: earlier }),
        h.stored(3, "thread.interaction-mode-updated", { interactionMode: mode }),
        ...h.state.history.slice(1).map((event) => ({ ...event, sequence: event.sequence + 2 })),
      ];
      const worker = yield* h.make;
      h.finish("completed", 6);
      yield* worker.run;
      assert.lengthOf(yield* h.entries, mode === "plan" ? 1 : 0);
    }),
);

it.effect("compares metadata and mode event sequences rather than preferring one event type", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    h.state.history = [
      h.stored(1, "thread.created", { interactionMode: "default" }),
      h.stored(2, "thread.interaction-mode-updated", { interactionMode: "default" }),
      h.stored(3, "thread.metadata-updated", { interactionMode: "plan" }),
      ...h.state.history.slice(1).map((event) => ({ ...event, sequence: event.sequence + 2 })),
    ];
    const worker = yield* h.make;
    h.finish("completed", 6);
    yield* worker.run;
    assert.lengthOf(yield* h.entries, 1);
  }),
);

it.effect(
  "captures restart reconciliation and partial or absent plans without claiming readiness",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const worker = yield* h.make;
      h.state.sources = [];
      const terminal = h.finish("interrupted");
      h.state.history[h.state.history.length - 1] = {
        ...terminal,
        commandId: CommandId.make("command:runtime-reconcile:restart"),
      };
      h.state.archived = true; // Archiving a completed thread does not erase its evidence.
      yield* worker.run;
      const [entry] = yield* h.entries;
      assert.include(entry!.text, "No plan, answer or question was recorded");
      assert.include(entry!.next!, "resume planning");
      assert.isFalse((yield* h.tickets.get(h.ticket.id)).ticket.workState?.resultReady);
    }),
);

it.effect("a new terminal snapshot for the same run is idempotent", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const worker = yield* h.make;
    h.finish();
    h.finish("completed", 5);
    yield* worker.run;
    const entries: TicketEvent[] = yield* h.entries;
    assert.lengthOf(entries, 1);
  }),
);
