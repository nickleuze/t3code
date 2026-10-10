import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
  type RunId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** How long a run may wait on the user before the thread that started it hears about it. */
export const WAITING_NOTICE_DELAY_MS = 20_000;

const PREAMBLE = "Automatic update from T3 Code (not a message from the user, and not approval):";
const TITLE_MAX_LENGTH = 80;
/** The only event types the reactor subscribes to, so it never retains unrelated tool bodies. */
const OBSERVED_TYPES = ["run.updated", "runtime-request.updated"] as const;

type Work =
  | { readonly type: "finished"; readonly run: OrchestrationV2Run }
  | {
      readonly type: "waiting";
      readonly threadId: ThreadId;
      readonly requestId: RuntimeRequestId;
      readonly runId: RunId | undefined;
    };

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

const WAITING_FOR: Partial<Record<OrchestrationV2RuntimeRequest["kind"], string>> = {
  user_input: "is waiting for the user to answer a question",
  "mcp-elicitation": "is waiting for the user to respond to an MCP request",
  command: "is waiting for the user to approve a command",
  "file-read": "is waiting for the user to approve a file read",
  "file-change": "is waiting for the user to approve a file change",
  permission: "is waiting for the user to grant a permission",
};

function titleOf(thread: OrchestrationV2AppThread): string {
  const firstLine = thread.title.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…`
    : firstLine;
}

/** App-owned delegate_task children already report to their parent through the delegated-task path. */
function appOwnedSubagentParent(thread: OrchestrationV2AppThread): ThreadId | undefined {
  return thread.lineage.relationshipToParent === "subagent" &&
    thread.lineage.parentThreadId !== null &&
    thread.forkedFrom?.type === "node"
    ? thread.lineage.parentThreadId
    : undefined;
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
    // Startup reconciliation settles runs left over from before the restart.
    !String(stored.commandId).startsWith("command:runtime-reconcile:")
  );
}

/**
 * Tells a thread when work its agent started in another thread ends or stops on
 * the user. Threads launched with t3_thread_launch/create_threads and turns sent
 * with t3_thread_send report back to the sending thread; a delegated child that
 * waits on the user reports to its parent. Each notice is an ordinary queued
 * notification message whose command and message ids derive from the run or
 * request, so command receipts deliver it at most once. Only live events are
 * observed, like the orchestrator's own terminal-run listener.
 */
export const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const timers = yield* FiberMap.make<string>();
  // Deadlines of armed wait timers, so `drain` can wait for the ones already due.
  const timerDeadlines = yield* TxRef.make<ReadonlyMap<string, number>>(new Map());
  // Highest sequence each subscription has handled, so `drain` knows what it has not seen yet.
  const observedSequence = {
    "run.updated": yield* TxRef.make(0),
    "runtime-request.updated": yield* TxRef.make(0),
  };
  const setDeadline = (key: string, deadline: number | undefined) =>
    TxRef.update(timerDeadlines, (current) => {
      const next = new Map(current);
      if (deadline === undefined) next.delete(key);
      else next.set(key, deadline);
      return next;
    });

  const isReachable = (threadId: ThreadId) =>
    orchestrator.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }) => thread.archivedAt === null && thread.deletedAt === null),
      Effect.orElseSucceed(() => false),
    );

  const deliver = Effect.fn("ThreadReportBack.deliver")(function* (input: {
    readonly key: string;
    readonly source: OrchestrationV2AppThread;
    readonly recipient: ThreadId;
    readonly notification: OrchestrationV2Notification;
    readonly text: string;
  }) {
    if (!(yield* isReachable(input.recipient))) return;
    const id = `thread-report-back:${input.key}:${input.recipient}`;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      threadId: input.recipient,
      senderThreadId: input.source.id,
      notification: input.notification,
      text: input.text,
      attachments: [],
      // Notifications only queue: an idle recipient starts a turn now, a busy
      // one hears about it after its current turn.
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const runSenders = (threadId: ThreadId, runId: RunId) =>
    orchestrator
      .getThreadRecords(threadId, ["messages"], {
        messageRunIds: [runId],
        messageRoles: ["user"],
      })
      .pipe(Effect.map(({ messages }) => agentSenders(threadId, messages)));

  const reportFinished = Effect.fn("ThreadReportBack.reportFinished")(function* (
    run: OrchestrationV2Run,
  ) {
    const finished = FINISHED[run.status];
    if (finished === undefined) return;
    const { thread } = yield* orchestrator.getThreadRecords(run.threadId, []);
    if (thread.deletedAt !== null || appOwnedSubagentParent(thread) !== undefined) return;
    const title = titleOf(thread);
    for (const recipient of yield* runSenders(thread.id, run.id)) {
      yield* deliver({
        key: `finished:${thread.id}:${run.id}`,
        source: thread,
        recipient,
        notification: {
          source: { kind: "subagent", childThreadId: thread.id },
          outcome: finished.outcome,
          summary: `Thread "${title}" ${finished.verb}`,
        },
        text: `${PREAMBLE} thread "${title}" (${thread.id}) ${finished.verb}. Read its result with t3_thread_read({threadId:"${thread.id}"}).`,
      });
    }
  });

  const reportWaiting = Effect.fn("ThreadReportBack.reportWaiting")(function* (
    work: Extract<Work, { readonly type: "waiting" }>,
  ) {
    const records = yield* orchestrator.getThreadRecords(
      work.threadId,
      ["runtimeRequests", "runs"],
      work.runId === undefined ? undefined : { runIds: [work.runId] },
    );
    const request = records.runtimeRequests.find((candidate) => candidate.id === work.requestId);
    const waitingFor = request === undefined ? undefined : WAITING_FOR[request.kind];
    if (request?.status !== "pending" || waitingFor === undefined) return;
    const thread = records.thread;
    if (thread.deletedAt !== null) return;
    const parent = appOwnedSubagentParent(thread);
    const run = records.runs
      .filter((candidate) => candidate.status !== "queued")
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .at(-1);
    const recipients =
      parent !== undefined
        ? [parent]
        : run === undefined
          ? []
          : yield* runSenders(thread.id, run.id);
    const title = titleOf(thread);
    for (const recipient of recipients) {
      yield* deliver({
        key: `waiting:${thread.id}:${request.id}`,
        source: thread,
        recipient,
        notification: {
          source: { kind: "subagent", childThreadId: thread.id },
          outcome: "updated",
          summary: `Thread "${title}" is waiting for the user`,
        },
        text: `${PREAMBLE} thread "${title}" (${thread.id}) ${waitingFor}. Tell the user it needs them; do not answer or approve it on their behalf unless the user told you to. Inspect it with t3_thread_read({threadId:"${thread.id}"}).`,
      });
    }
  });

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(message, { ...fields, cause });

  const worker = yield* makeDrainableWorker((work: Work) =>
    (work.type === "finished" ? reportFinished(work.run) : reportWaiting(work)).pipe(
      Effect.catchCause(
        logSkipped("orchestration-v2.thread-report-back.failed", {
          type: work.type,
          threadId: work.type === "finished" ? work.run.threadId : work.threadId,
        }),
      ),
    ),
  );

  const observe = (stored: OrchestrationV2StoredEvent) =>
    Effect.gen(function* () {
      const event = stored.event;
      if (event.type === "run.updated" && isTerminalRunUpdate(stored)) {
        yield* worker.enqueue({ type: "finished", run: event.payload });
      } else if (event.type === "runtime-request.updated") {
        const key = `${event.threadId}:${event.payload.id}`;
        if (event.payload.status !== "pending") {
          yield* FiberMap.remove(timers, key);
          yield* setDeadline(key, undefined);
        } else if (
          WAITING_FOR[event.payload.kind] !== undefined &&
          !(yield* FiberMap.has(timers, key))
        ) {
          // The deadline is fixed when the request is seen, not when the timer fiber starts.
          const deadline = (yield* Clock.currentTimeMillis) + WAITING_NOTICE_DELAY_MS;
          const work: Work = {
            type: "waiting",
            threadId: event.threadId,
            requestId: event.payload.id,
            runId: event.runId,
          };
          yield* setDeadline(key, deadline);
          yield* FiberMap.run(
            timers,
            key,
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => Effect.sleep(Duration.millis(Math.max(0, deadline - now)))),
              Effect.andThen(worker.enqueue(work)),
              Effect.andThen(setDeadline(key, undefined)),
            ),
          );
        }
      }
      if (event.type === "run.updated" || event.type === "runtime-request.updated") {
        yield* TxRef.set(observedSequence[event.type], stored.sequence);
      }
    });

  const start = Effect.fn("ThreadReportBack.start")(function* () {
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    for (const eventType of OBSERVED_TYPES) {
      yield* TxRef.set(observedSequence[eventType], afterSequence);
    }
    yield* Stream.mergeAll(
      OBSERVED_TYPES.map((eventType) => eventSink.stream({ afterSequence, eventType })),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach(observe),
      Effect.catchCause(logSkipped("orchestration-v2.thread-report-back.stream-failed", {})),
      Effect.forkScoped,
    );
  });

  /** Waits until the subscription for `eventType` has handled its last committed event through `latest`. */
  const awaitObserved = (eventType: (typeof OBSERVED_TYPES)[number], latest: number) =>
    Effect.gen(function* () {
      const observed = yield* TxRef.get(observedSequence[eventType]);
      const unobserved = yield* eventStore
        .read({ afterSequence: observed, throughSequence: latest, eventType })
        .pipe(Stream.runLast, Effect.orDie);
      if (Option.isNone(unobserved)) return;
      const target = unobserved.value.sequence;
      yield* TxRef.get(observedSequence[eventType]).pipe(
        Effect.tap((current) => (current < target ? Effect.txRetry : Effect.void)),
        Effect.tx,
      );
    });

  /**
   * Resolves once every committed event of the observed types was handled and
   * its work, including wait timers already due, finished. Timers not yet due
   * do not block.
   */
  const drain = Effect.gen(function* () {
    while (true) {
      const latest = yield* eventSink.latestSequence().pipe(Effect.orDie);
      for (const eventType of OBSERVED_TYPES) {
        yield* awaitObserved(eventType, latest);
      }
      yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const deadlines = yield* TxRef.get(timerDeadlines);
        if ([...deadlines.values()].some((deadline) => deadline <= now)) {
          return yield* Effect.txRetry;
        }
      }).pipe(Effect.tx);
      yield* worker.drain;
      if ((yield* eventSink.latestSequence().pipe(Effect.orDie)) === latest) return;
    }
  });

  return { start, drain };
});

export const layer = Layer.effectDiscard(make.pipe(Effect.flatMap((reactor) => reactor.start())));
