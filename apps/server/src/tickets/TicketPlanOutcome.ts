import { type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as Tickets from "./TicketService.ts";

const FINISHED = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

/** Records planning evidence without asking a planning provider to perform writes. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const events = yield* EventStore.EventStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const tickets = yield* Tickets.TicketService;

  // Local delivery state, not a synced Ticket event or a historical backfill.
  yield* sql`CREATE TABLE IF NOT EXISTS fork_ticket_plan_outcome_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL
  )`;
  const baseline = yield* sink.latestSequence();
  yield* sql`INSERT INTO fork_ticket_plan_outcome_cursor (id, sequence)
    VALUES (1, ${baseline}) ON CONFLICT DO NOTHING`;

  const record = Effect.fn("TicketPlanOutcome.record")(function* (
    stored: OrchestrationV2StoredEvent,
  ) {
    if (stored.event.type !== "run.updated") return;
    const run = stored.event.payload;
    if (!FINISHED.has(run.status) || !run.startedAt || !run.completedAt) return;
    const machine = tickets.author().machine;
    const completedAt = DateTime.formatIso(run.completedAt);
    const linked = (yield* tickets.ticketsLinkedToThread(run.threadId, machine)).filter(
      ({ reference }) =>
        ["work", "planning", "review"].includes(reference.role) && reference.at <= completedAt,
    );
    if (!linked.length) return;
    // A queued run can change modes before it starts. Anchor to its first
    // started event, not the terminal event or today's mutable thread setting.
    const started = yield* events
      .read({
        threadId: run.threadId,
        throughSequence: stored.sequence,
        eventType: "run.updated",
      })
      .pipe(
        Stream.filter(
          (event) =>
            event.event.type === "run.updated" &&
            event.event.payload.id === run.id &&
            event.event.payload.startedAt !== null &&
            event.event.payload.completedAt === null,
        ),
        Stream.take(1),
        Stream.runLast,
      );
    const created = Option.isSome(started)
      ? started
      : yield* events
          .read({
            threadId: run.threadId,
            throughSequence: stored.sequence,
            eventType: "run.created",
          })
          .pipe(
            Stream.filter(
              (event) => event.event.type === "run.created" && event.event.payload.id === run.id,
            ),
            Stream.take(1),
            Stream.runLast,
          );
    if (Option.isNone(created)) return;
    const metadata = yield* events
      .read({
        threadId: run.threadId,
        throughSequence: created.value.sequence,
        eventType: "thread.metadata-updated",
      })
      .pipe(Stream.runLast);
    const mode = yield* events
      .read({
        threadId: run.threadId,
        throughSequence: created.value.sequence,
        eventType: "thread.interaction-mode-updated",
      })
      .pipe(Stream.runLast);
    const latest =
      Option.isSome(mode) &&
      (Option.isNone(metadata) || mode.value.sequence > metadata.value.sequence)
        ? mode
        : metadata;
    const snapshot = Option.isSome(latest)
      ? latest
      : yield* events
          .read({
            threadId: run.threadId,
            throughSequence: created.value.sequence,
            eventType: "thread.created",
          })
          .pipe(Stream.runLast);
    const planning =
      Option.isSome(snapshot) &&
      (snapshot.value.event.type === "thread.metadata-updated" ||
        snapshot.value.event.type === "thread.interaction-mode-updated" ||
        snapshot.value.event.type === "thread.created") &&
      snapshot.value.event.payload.interactionMode === "plan";
    if (!planning) return;
    const { thread, turnItems } = yield* orchestrator.getThreadRecords(
      run.threadId,
      ["turnItems"],
      {
        turnItemRunId: run.id,
        turnItemTypes: ["proposed_plan", "assistant_message", "user_input_request"],
      },
    );
    if (thread.deletedAt !== null) return;
    const sources = turnItems.filter((item) => item.runId === run.id);
    const plan = sources.findLast((item) => item.type === "proposed_plan");
    const source = `t3-thread://v1/${run.threadId}`;
    const pointers = [
      plan,
      sources.findLast((item) => item.type === "assistant_message"),
      sources.findLast((item) => item.type === "user_input_request"),
    ].flatMap((item) => (item ? [`${item.type}: ${item.id}`] : []));
    const text = [
      `Planning outcome: run ${run.status} at ${completedAt}.`,
      `Source: ${source}\nRun: ${run.id}`,
      ...pointers,
      pointers.length
        ? "Read these source items for the plan, corrections and questions; their content is not copied here."
        : "No plan, answer or question was recorded in this run.",
      "Recorded automatically by T3. This is evidence, not acceptance of scope or permission to implement.",
    ].join("\n\n");
    for (const { id } of linked) {
      const { ticket } = yield* tickets.get(id);
      if (ticket.deletedAt !== null || ticket.status === "done" || ticket.status === "dropped")
        continue;
      const next = ticket.workState?.nextAction;
      // Bookkeeping never replaces an already recorded action or decision.
      // Older handoffs may put "Next:" only in their text. Do not hide that
      // authored context behind an automatic action or infer its prose as next.
      const hasNext = next != null || ticket.workState?.lastHandoff != null;
      yield* tickets.entry(
        {
          id,
          kind: "note",
          text,
          ...(!hasNext
            ? {
                next:
                  run.status === "completed"
                    ? `Review the planning outcome in ${source} and record the decision needed to continue. Planning alone does not authorize implementation.`
                    : `Review the partial planning outcome in ${source} and decide whether to resume planning.`,
              }
            : {}),
          clientRequestId: `plan-outcome:${run.id}:${id}`,
        },
        tickets.author({ actor: "agent", thread: run.threadId, model: run.modelSelection.model }),
        "ticket-plan-outcome",
        completedAt,
      );
    }
  });

  // A failed record does not advance the cursor. Entry request keys also cover a
  // crash between the durable entry and cursor update, including partial fan-out.
  const run = Effect.gen(function* () {
    const [cursor] = yield* sql<{
      sequence: number;
    }>`SELECT sequence FROM fork_ticket_plan_outcome_cursor WHERE id = 1`;
    yield* sink.stream({ afterSequence: cursor!.sequence, eventType: "run.updated" }).pipe(
      Stream.runForEach((stored) =>
        Effect.gen(function* () {
          yield* record(stored);
          yield* sql`UPDATE fork_ticket_plan_outcome_cursor SET sequence = ${stored.sequence} WHERE id = 1`;
        }),
      ),
    );
  });
  return { run };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* make;
    yield* forkParked(
      worker.run.pipe(
        Effect.tapError(() => Effect.logWarning("tickets.plan-outcome.retrying")),
        Effect.retry(Schedule.spaced("5 seconds")),
      ),
    );
  }),
);
