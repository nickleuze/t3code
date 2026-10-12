import { type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Tickets from "./TicketService.ts";

const OBSERVED_TYPES = new Set([
  "run.created",
  "thread.created",
  "thread.metadata-updated",
  "thread.pull-request-synced",
  "thread.settled",
  "runtime-request.updated",
  "subagent.updated",
]);
export const make = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const tickets = yield* Tickets.TicketService;
  const projection = yield* Effect.serviceOption(Projection.ProjectionStoreV2);
  const knownGoals = new Set<string>();
  const knownIterations = new Set<string>();
  const refreshReference = (
    threadId: import("@t3tools/contracts").ThreadId,
    kind: "goal" | "task" | "pr",
    ref: string,
    title: string,
    model?: string,
  ) =>
    Effect.gen(function* () {
      for (const { id, reference } of yield* tickets.ticketsLinkedToReference(
        kind,
        ref,
        tickets.author().machine,
      )) {
        yield* tickets.reference(
          { id, kind, ref, role: reference.role, title },
          tickets.author({ actor: "agent", thread: threadId, ...(model ? { model } : {}) }),
        );
      }
    });
  const worker = yield* makeDrainableWorker((stored: OrchestrationV2StoredEvent) =>
    Effect.gen(function* () {
      if (String(stored.commandId).startsWith("command:runtime-reconcile:")) return;
      const event = stored.event;
      if (event.type === "run.created") {
        for (const { id, reference: link } of yield* tickets.ticketsLinkedToThread(
          event.payload.threadId,
          tickets.author().machine,
        )) {
          if (["work", "planning"].includes(link.role))
            yield* tickets.link(
              {
                id,
                threadId: event.payload.threadId,
                role: link.role,
                startWork: true,
                title: link.title,
              },
              tickets.author({
                actor: "agent",
                thread: event.payload.threadId,
                model: event.payload.modelSelection?.model,
              }),
            );
        }
      }
      if (
        event.type === "thread.metadata-updated" ||
        event.type === "thread.created" ||
        event.type === "thread.pull-request-synced"
      ) {
        const thread = event.payload;
        const linked = yield* tickets.ticketsLinkedToThread(thread.id, tickets.author().machine);
        for (const { id, reference: link } of linked)
          yield* tickets.reference(
            {
              id,
              kind: "thread",
              ref: thread.id,
              role: link.role,
              title: thread.title,
            },
            tickets.author({
              actor: "agent",
              thread: thread.id,
              model: thread.modelSelection?.model,
            }),
          );
        if (event.type === "thread.pull-request-synced") {
          for (const pr of thread.pullRequests ?? []) {
            if (pr.source === "stack-dismissed") continue;
            const snapshot = pr.snapshot;
            // A link without a fetched snapshot cannot establish draft status.
            if (!snapshot) continue;
            if (!snapshot.isDraft)
              yield* tickets.observe({
                threadId: thread.id,
                key: `pr-linked:${pr.url}`,
                kind: "pr_linked",
                isDraft: snapshot.isDraft,
                model: thread.modelSelection?.model,
                ref: pr.url,
                title: `#${pr.number}: ${snapshot.title}`,
              });
            yield* refreshReference(
              thread.id,
              "pr",
              pr.url,
              `#${pr.number}: ${snapshot.title}`,
              thread.modelSelection?.model,
            );
            if (snapshot.state === "merged" || snapshot.state === "closed")
              yield* tickets.observe({
                threadId: thread.id,
                key: `pr-${snapshot.state}:${pr.url}`,
                kind: snapshot.state === "merged" ? "pr_merged" : "pr_closed",
                model: thread.modelSelection?.model,
                ref: pr.url,
              });
          }
        }
        if (thread.goal) {
          const firstSeen = !knownGoals.has(thread.goal.id);
          const isNewGoal =
            firstSeen &&
            thread.goal.status === "active" &&
            thread.goal.iteration === 0 &&
            thread.goal.createdAt === thread.goal.updatedAt &&
            thread.goal.history.length === 0;
          knownGoals.add(thread.goal.id);
          // A first snapshot of an older goal establishes a baseline, not a start.
          if (firstSeen && !isNewGoal)
            for (const iteration of thread.goal.history)
              knownIterations.add(`goal-iteration:${thread.goal.id}:${iteration.iteration}`);
          for (const { id, reference: link } of linked) {
            if (link.role === "work" && isNewGoal)
              yield* tickets.link({
                id,
                threadId: thread.id,
                role: "work",
                startWork: true,
                title: thread.title,
              });
          }
          const goal = thread.goal;
          if (isNewGoal)
            yield* tickets.observe({
              threadId: thread.id,
              key: `goal-started:${goal.id}`,
              kind: "thread_started",
              ref: goal.id,
              referenceKind: "goal",
              title: goal.objective,
              model: thread.modelSelection?.model,
            });
          yield* refreshReference(
            thread.id,
            "goal",
            goal.id,
            goal.objective,
            thread.modelSelection?.model,
          );
          for (const iteration of goal.history) {
            const key = `goal-iteration:${goal.id}:${iteration.iteration}`;
            if (knownIterations.has(key)) continue;
            knownIterations.add(key);
            yield* tickets.observe({
              threadId: thread.id,
              key,
              kind: "goal_iteration_done",
              ref: `${goal.id}:${iteration.iteration}`,
            });
          }
        }
      }
      if (event.type === "thread.settled")
        yield* tickets.observe({
          threadId: event.payload.id,
          key: `settled:${stored.sequence}`,
          kind: "thread_settled",
          ref: event.payload.id,
        });
      if (event.type === "runtime-request.updated" && event.payload.status === "pending")
        yield* tickets.observe({
          threadId: event.threadId,
          key: `request:${event.payload.id}`,
          kind: "needs_input",
          ref: event.payload.id,
        });
      if (event.type === "subagent.updated" && event.payload.origin === "app_owned") {
        const task = event.payload;
        if (!["completed", "failed", "cancelled", "interrupted"].includes(task.status)) {
          yield* tickets.observe({
            threadId: task.threadId,
            key: `task-started:${task.id}`,
            kind: "thread_started",
            ref: task.id,
            referenceKind: "task",
            title: task.title ?? task.prompt,
            model: task.model ?? task.modelSelection?.model,
          });
        }
        yield* refreshReference(
          task.threadId,
          "task",
          task.id,
          task.title ?? task.prompt,
          task.model ?? task.modelSelection?.model,
        );
        if (["completed", "failed", "cancelled", "interrupted"].includes(task.status))
          yield* tickets.observe({
            threadId: task.threadId,
            key: `task-done:${task.id}`,
            kind: "task_done",
            ref: task.id,
          });
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("tickets.observation.failed", { cause })),
    ),
  );
  const start = Effect.gen(function* () {
    const afterSequence = yield* sink.latestSequence().pipe(Effect.orDie);
    if (projection._tag === "Some")
      for (const thread of yield* projection.value.getGoalThreads().pipe(Effect.orDie)) {
        if (!thread.goal) continue;
        knownGoals.add(thread.goal.id);
        for (const iteration of thread.goal.history)
          knownIterations.add(`goal-iteration:${thread.goal.id}:${iteration.iteration}`);
      }
    yield* sink.stream({ afterSequence }).pipe(
      Stream.filter((stored) => OBSERVED_TYPES.has(stored.event.type)),
      Stream.runForEach(worker.enqueue),
      Effect.forkScoped,
    );
  });
  return { start, observe: worker.enqueue, drain: worker.drain };
});
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* make;
    yield* worker.start;
  }),
);
