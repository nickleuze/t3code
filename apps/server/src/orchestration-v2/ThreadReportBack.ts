import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";

const PREAMBLE = "Automatic update from T3 Code (not a message from the user, and not approval):";
const TITLE_MAX_LENGTH = 80;
/** How far back the startup sweep looks for runs whose report was never delivered. */
const SWEEP_LOOKBACK = Duration.days(1);

type FinishedRun = Pick<OrchestrationV2Run, "id" | "threadId" | "status">;

const FINISHED: Partial<
  Record<
    OrchestrationV2Run["status"],
    { readonly outcome: OrchestrationV2Notification["outcome"]; readonly verb: string }
  >
> = {
  completed: { outcome: "completed", verb: "finished" },
  failed: { outcome: "failed", verb: "failed" },
  cancelled: { outcome: "cancelled", verb: "was stopped" },
  interrupted: { outcome: "cancelled", verb: "was stopped" },
  rolled_back: { outcome: "cancelled", verb: "was rolled back" },
};

function titleOf(thread: OrchestrationV2AppThread): string {
  const firstLine = thread.title.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…`
    : firstLine;
}

/** App-owned delegate_task children already report to their parent through the delegated-task path. */
function isAppOwnedSubagent(thread: OrchestrationV2AppThread): boolean {
  return (
    thread.lineage.relationshipToParent === "subagent" &&
    thread.lineage.parentThreadId !== null &&
    thread.forkedFrom?.type === "node"
  );
}

/**
 * Other threads whose agent started or steered this run. Automatic notices and
 * delegated completions never count, so a turn they start cannot report back.
 */
function agentSenders(
  threadId: ThreadId,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): ReadonlyArray<ThreadId> {
  const senders = new Set<ThreadId>();
  for (const message of messages) {
    if (
      message.role === "user" &&
      message.createdBy === "agent" &&
      message.senderThreadId !== undefined &&
      message.senderThreadId !== threadId &&
      message.notification === undefined &&
      message.delegatedCompletion === undefined
    ) {
      senders.add(message.senderThreadId);
    }
  }
  return [...senders];
}

function isTerminalRunUpdate(stored: OrchestrationV2StoredEvent): boolean {
  return (
    stored.event.type === "run.updated" &&
    FINISHED[stored.event.payload.status] !== undefined &&
    // Runtime reconciliation settles runs a restart cut short; the startup sweep reports them.
    !String(stored.commandId).startsWith("command:runtime-reconcile:")
  );
}

/**
 * Tells a thread when work its agent started in another thread ends. Threads
 * launched with t3_thread_launch/create_threads and turns sent with
 * t3_thread_send report back to the sending thread. Each notice is an ordinary
 * queued notification message whose command and message ids derive from the
 * run, so command receipts deliver it at most once. Live terminal runs are
 * reported as they commit; after a restart, a sweep re-offers recently ended
 * runs, which covers runs that ended unreported while the server was down or
 * that restart reconciliation stopped.
 */
export const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;

  const isReachable = (threadId: ThreadId) =>
    orchestrator.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }) => thread.archivedAt === null && thread.deletedAt === null),
      Effect.orElseSucceed(() => false),
    );

  const reportFinished = Effect.fn("ThreadReportBack.reportFinished")(function* (run: FinishedRun) {
    const finished = FINISHED[run.status];
    if (finished === undefined) return;
    const { thread, messages } = yield* orchestrator.getThreadRecords(run.threadId, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["user"],
    });
    if (thread.deletedAt !== null || isAppOwnedSubagent(thread)) return;
    const title = titleOf(thread);
    for (const recipient of agentSenders(thread.id, messages)) {
      if (!(yield* isReachable(recipient))) continue;
      const id = `thread-report-back:finished:${thread.id}:${run.id}:${recipient}`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        messageId: MessageId.make(id),
        threadId: recipient,
        senderThreadId: thread.id,
        notification: {
          source: { kind: "subagent", childThreadId: thread.id },
          outcome: finished.outcome,
          summary: `Thread "${title}" ${finished.verb}`,
        },
        text: `${PREAMBLE} thread "${title}" (${thread.id}) ${finished.verb}. Read its result with t3_thread_read({threadId:"${thread.id}"}).`,
        attachments: [],
        // Notifications only queue: an idle recipient starts a turn now, a busy
        // one hears about it after its current turn.
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    }
  });

  const worker = yield* makeDrainableWorker((run: FinishedRun) =>
    reportFinished(run).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("orchestration-v2.thread-report-back.failed", {
            threadId: run.threadId,
            runId: run.id,
            cause,
          }),
      ),
    ),
  );

  const start = Effect.fn("ThreadReportBack.start")(function* () {
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* eventSink.stream({ afterSequence, eventType: "run.updated" }).pipe(
      Stream.runForEach((stored) =>
        stored.event.type === "run.updated" && isTerminalRunUpdate(stored)
          ? worker.enqueue(stored.event.payload)
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.thread-report-back.stream-failed", { cause }),
      ),
      Effect.forkScoped,
    );
  });

  /** Queues every recently ended run another thread's agent started; receipts drop repeats. */
  const sweep = Effect.gen(function* () {
    const since = DateTime.formatIso(
      DateTime.subtractDuration(yield* DateTime.now, SWEEP_LOOKBACK),
    );
    const runs = yield* sql<FinishedRun>`
      SELECT run.run_id AS id, run.thread_id AS "threadId", run.status
      FROM orchestration_v2_projection_runs AS run
      WHERE run.status IN ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back')
        AND run.completed_at >= ${since}
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_messages AS message
          WHERE message.run_id = run.run_id
            AND message.role = 'user'
            AND json_extract(message.payload_json, '$.createdBy') = 'agent'
            AND json_extract(message.payload_json, '$.senderThreadId') IS NOT NULL
        )
      ORDER BY run.completed_at
    `;
    yield* Effect.forEach(runs, worker.enqueue, { discard: true });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("orchestration-v2.thread-report-back.sweep-failed", { cause }),
    ),
  );

  return { start, sweep, drain: worker.drain };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* make;
    yield* reactor.start();
    // After startup recovery, so the runs it stopped are already settled.
    yield* forkParked(reactor.sweep);
  }),
);
