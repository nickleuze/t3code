import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { applyGoalCommand, goalSummary } from "./GoalState.ts";

const now = DateTime.makeUnsafe("2026-10-10T12:00:00.000Z");
const threadId = ThreadId.make("thread:t3-goal-persistence");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:t3-goal-persistence"),
  title: "T3 goal",
  providerInstanceId: instanceId,
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
const result = applyGoalCommand(
  thread,
  {
    type: "set",
    commandId: CommandId.make("t3-goal:persistence"),
    objective: "Validate candidate",
    modelSelection,
    runtimeMode: "full-access",
    checkCommand: "node --test",
    burnGuard: null,
    noProgressLimit: undefined,
    doneWhen: "Checks pass",
    background: null,
    permissions: null,
    iterationTimeoutMins: undefined,
  },
  DateTime.formatIso(now),
);
if (!result.ok || result.goal === null) throw new Error("Goal fixture must be valid");
const t3Goal = result.goal;
const created: OrchestrationV2DomainEvent = {
  id: EventId.make("event:t3-goal-created"),
  type: "thread.created",
  threadId,
  occurredAt: now,
  payload: { ...thread, goal: t3Goal },
};
const encodeEvent = Schema.encodeSync(OrchestrationV2DomainEventJson);
const decodeEvent = Schema.decodeSync(OrchestrationV2DomainEventJson);

it("retains old fork goal fields when decoding stored events and accepts pre-goal events", () => {
  const replayed = decodeEvent(encodeEvent(created));
  assert.equal(replayed.type, "thread.created");
  if (replayed.type !== "thread.created") throw new Error("Wrong event");
  assert.deepEqual(replayed.payload.goal, t3Goal);
  const old = decodeEvent(encodeEvent({ ...created, payload: thread }));
  if (old.type !== "thread.created") throw new Error("Wrong event");
  assert.isUndefined(old.payload.goal);
});

const persistenceBehavior = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  // Decode first, as restart replay does; this is not a synthetic in-memory bypass.
  yield* store.apply(decodeEvent(encodeEvent(created)));
  assert.deepEqual((yield* store.getThread(threadId)).goal, t3Goal);
  for (const status of ["active", "paused", "blocked", "usageLimited"] as const) {
    yield* store.apply({
      ...created,
      id: EventId.make(`event:goal:${status}`),
      type: "thread.metadata-updated",
      payload: { ...thread, goal: { ...t3Goal, status } },
    });
    assert.deepEqual(yield* store.getSettlementCandidates(threadId), []);
  }
  const nativeGoal = { objective: "Provider task", status: "active" as const, tokensUsed: 10 };
  const driver = ProviderDriverKind.make("codex");
  yield* store.apply({
    id: EventId.make("event:native-goal"),
    type: "provider-thread.updated",
    threadId,
    driver,
    occurredAt: now,
    payload: {
      id: ProviderThreadId.make("provider:t3-goal-persistence"),
      driver,
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      goal: nativeGoal,
      createdAt: now,
      updatedAt: now,
    },
  });
  const shell = yield* store.getThreadShell(threadId);
  assert.deepEqual(shell?.goal, nativeGoal);
  assert.deepEqual(shell?.t3Goal, goalSummary({ ...t3Goal, status: "usageLimited" }));
  yield* store.apply({
    ...created,
    id: EventId.make("event:goal:complete"),
    type: "thread.metadata-updated",
    payload: { ...thread, goal: { ...t3Goal, status: "complete" } },
  });
  assert.equal((yield* store.getSettlementCandidates(threadId)).length, 1);
});

it.effect(
  "preserves T3 and native goals independently in SQLite and excludes live loops from settlement",
  () =>
    persistenceBehavior.pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
);
it.effect("preserves the same goal replay and settlement behavior in memory", () =>
  persistenceBehavior.pipe(Effect.provide(ProjectionStore.layerMemory)),
);
