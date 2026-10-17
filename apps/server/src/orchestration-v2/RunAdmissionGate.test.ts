import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunAdmissionGate from "./RunAdmissionGate.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerStores = Layer.mergeAll(
  layerDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
);
const layerGate = RunAdmissionGate.layer.pipe(Layer.provide(layerDatabase));
const layerTest = Layer.mergeAll(
  layerStores,
  layerGate,
  EventSink.layer.pipe(Layer.provide(Layer.merge(layerStores, layerGate))),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadEvent(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:${threadId}:thread`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: now,
    payload: makeThread(threadId, now),
  };
}

function runEvent(
  threadId: ThreadId,
  name: string,
  status: OrchestrationV2Run["status"],
  now: DateTime.Utc,
  type: "run.created" | "run.updated" = "run.created",
): OrchestrationV2DomainEvent {
  const runId = RunId.make(`run:${threadId}:${name}`);
  return {
    id: EventId.make(`event:${threadId}:${name}:${type}:${status}`),
    type,
    threadId,
    runId,
    providerInstanceId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${threadId}:${name}`),
      rootNodeId: null,
      activeAttemptId: RunAttemptId.make(`attempt:${threadId}:${name}`),
      status,
      queuePosition: status === "queued" ? 1 : null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

it.effect("rejects new runs while closed and keeps queued work", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const gate = yield* RunAdmissionGate.RunAdmissionGate;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:gate-closed");
    yield* eventSink.write({ events: [threadEvent(threadId, now)] });

    assert.deepEqual(yield* gate.closeWhenIdle("Mini is installing 1.0.0-nick.2"), {
      closed: true,
    });

    const rejected = yield* eventSink
      .write({ events: [runEvent(threadId, "new", "starting", now)] })
      .pipe(Effect.flip);
    assert.isTrue(RunAdmissionGate.isRunAdmissionClosed(rejected));
    assert.include(rejected.cause?.toString() ?? "", "Mini is installing 1.0.0-nick.2");

    yield* eventSink.write({ events: [runEvent(threadId, "queued", "queued", now)] });
    const records = yield* projection.getThreadRecords(threadId, ["runs"]);
    assert.deepEqual(
      records.runs.map((run) => run.status),
      ["queued"],
    );

    yield* gate.open;
    yield* eventSink.write({
      events: [runEvent(threadId, "queued", "starting", now, "run.updated")],
    });
    assert.deepEqual(
      (yield* projection.getThreadRecords(threadId, ["runs"])).runs.map((run) => run.status),
      ["starting"],
    );
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect("stays open and names the work while a run is blocking", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const gate = yield* RunAdmissionGate.RunAdmissionGate;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:gate-busy");
    yield* eventSink.write({
      events: [threadEvent(threadId, now), runEvent(threadId, "active", "waiting", now)],
    });

    const result = yield* gate.closeWhenIdle("installing");
    assert.deepEqual(result, {
      closed: false,
      blocking: [{ threadId, runId: `run:${threadId}:active` }],
    });
    assert.isUndefined(yield* gate.closedReason);
    // Existing runs keep progressing.
    yield* eventSink.write({
      events: [runEvent(threadId, "active", "completed", now, "run.updated")],
    });
    assert.deepEqual(yield* gate.closeWhenIdle("installing"), { closed: true });
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect("admits exactly one of a racing run start and an idle close", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const gate = yield* RunAdmissionGate.RunAdmissionGate;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    for (let round = 0; round < 20; round += 1) {
      yield* gate.open;
      const threadId = ThreadId.make(`thread:gate-race-${round}`);
      yield* eventSink.write({ events: [threadEvent(threadId, now)] });
      const [write, close] = yield* Effect.all(
        [
          eventSink
            .write({ events: [runEvent(threadId, "race", "starting", now)] })
            .pipe(Effect.result),
          gate.closeWhenIdle("installing"),
        ],
        { concurrency: "unbounded" },
      );
      const admitted = (yield* projection.getThreadRecords(threadId, ["runs"])).runs.length === 1;
      assert.strictEqual(write._tag === "Success", admitted);
      assert.strictEqual(close.closed, !admitted);
      // Finish the admitted run so the next round starts idle.
      if (admitted) {
        yield* eventSink.write({
          events: [runEvent(threadId, "race", "completed", now, "run.updated")],
        });
      }
    }
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);
