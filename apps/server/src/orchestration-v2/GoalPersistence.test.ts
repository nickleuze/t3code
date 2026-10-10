import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  OrchestrationV2DomainEventJson,
  OrchestrationV2ThreadGoalSummary,
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
import { buildGoalIterationPrompt } from "./GoalPrompt.ts";
import { goalIterationTimeoutMins } from "@t3tools/contracts";

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

it("accepts legacy shell goal summaries and round-trips the new transition timestamp", () => {
  const summary = goalSummary(t3Goal)!;
  const { updatedAt: _updatedAt, ...legacy } = summary;
  const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadGoalSummary);
  const encode = Schema.encodeSync(OrchestrationV2ThreadGoalSummary);
  assert.deepEqual(decode(legacy), legacy);
  assert.deepEqual(decode(encode(summary)), summary);
  assert.equal(summary.updatedAt, t3Goal.updatedAt);
});

it("retains old fork goal fields when decoding stored events and accepts pre-goal events", () => {
  const replayed = decodeEvent(encodeEvent(created));
  assert.equal(replayed.type, "thread.created");
  if (replayed.type !== "thread.created") throw new Error("Wrong event");
  assert.deepEqual(replayed.payload.goal, t3Goal);
  const old = decodeEvent(encodeEvent({ ...created, payload: thread }));
  if (old.type !== "thread.created") throw new Error("Wrong event");
  assert.isUndefined(old.payload.goal);
});

/**
 * A goal as the first fork release stored it (trimmed from a real owner
 * thread): no brief fields, no time limit, no uncached tokens or usage sample.
 */
const legacyGoal = {
  id: "1ceab76a-77bc-442d-85cc-c8f6f9ced574",
  objective: "Specifically improve the Profoto Models",
  status: "paused",
  statusReason: "iteration_timeout",
  checkCommand: null,
  burnGuard: { maxPercentPoints: 20, windowMins: 60 },
  noProgressLimit: 3,
  consecutiveNoProgress: 0,
  safetyCap: 100,
  iteration: 2,
  tokensUsed: 12_437_467,
  usageAccounting: "estimated",
  modelSelection: {
    instanceId: "codex",
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "max" }],
  },
  runtimeMode: "auto",
  progressNotes: [{ iteration: 2, text: "Pro-11 head modelled", at: "2026-10-05T14:51:00.000Z" }],
  current: null,
  lastCheck: null,
  history: [
    {
      iteration: 2,
      childThreadId: "thread:goal-iteration:legacy:2",
      outcome: "timed_out",
      tokens: 5_706_133,
      workspaceChanged: true,
      finishedAt: "2026-10-05T14:51:54.171Z",
    },
  ],
  resumeAt: null,
  completedSummary: null,
  createdAt: "2026-10-05T13:55:58.629Z",
  updatedAt: "2026-10-05T14:51:54.171Z",
} as const;

it.effect("replays goals saved before the brief, time floor and token split", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const encoded = encodeEvent({ ...created, type: "thread.metadata-updated" });
    if (encoded.type !== "thread.metadata-updated") throw new Error("Wrong event");
    for (const [iterationTimeoutMins, readAs] of [
      [undefined, 120],
      [20, 45],
    ] as const) {
      const event = decodeEvent({
        ...encoded,
        id: `event:legacy-goal:${iterationTimeoutMins ?? "none"}`,
        payload: {
          ...encoded.payload,
          goal: {
            ...legacyGoal,
            ...(iterationTimeoutMins === undefined ? {} : { iterationTimeoutMins }),
          },
        },
      });
      yield* store.apply(event);
      const goal = (yield* store.getThread(threadId)).goal!;
      assert.strictEqual(goalIterationTimeoutMins(goal), readAs);
      assert.include(buildGoalIterationPrompt(goal, 3), `about ${readAs} minutes`);
      assert.isUndefined(goal.uncachedTokensUsed);
      assert.isUndefined(goal.usageSample);
      assert.notProperty(goalSummary(goal)!, "uncachedTokensUsed");

      const edited = applyGoalCommand(
        { ...thread, goal },
        {
          type: "update",
          goalId: goal.id,
          brief: { doneWhen: "All three heads render", permissions: "Push to the branch" },
        },
        DateTime.formatIso(now),
      );
      if (!edited.ok) throw new Error(edited.reason);
      assert.deepInclude(edited.goal, {
        objective: legacyGoal.objective,
        doneWhen: "All three heads render",
        permissions: "Push to the branch",
        history: goal.history,
      });
    }
  }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

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

const discoveryBehavior = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply(created);
  for (const status of [
    "active",
    "usageLimited",
    "paused",
    "blocked",
    "complete",
    "stopped",
  ] as const) {
    yield* store.apply({
      ...created,
      type: "thread.metadata-updated",
      payload: { ...thread, goal: { ...t3Goal, status } },
    });
    assert.equal(
      (yield* store.getGoalThreads()).length,
      status === "active" || status === "usageLimited" ? 1 : 0,
    );
  }
  const current = {
    iteration: 1,
    childThreadId: ThreadId.make("iteration:pending"),
    startedAt: DateTime.formatIso(now),
    phase: "checking" as const,
    baselineRef: null,
    notesThisIteration: 0,
    claim: null,
    waitingOnRequest: null,
    finished: null,
  };
  for (const status of ["active", "paused", "stopped"] as const) {
    yield* store.apply({
      ...created,
      type: "thread.metadata-updated",
      payload: { ...thread, archivedAt: now, goal: { ...t3Goal, status, current } },
    });
    // Archived/stopped owners with unfinished work still need reconciliation.
    assert.equal((yield* store.getGoalThreads()).length, 1);
  }
  yield* store.apply({
    ...created,
    type: "thread.metadata-updated",
    payload: { ...thread, deletedAt: now, goal: { ...t3Goal, current } },
  });
  // An iteration is top-level, so deletion cannot abandon its cleanup.
  assert.equal((yield* store.getGoalThreads()).length, 1);
  yield* store.apply({
    ...created,
    type: "thread.metadata-updated",
    payload: { ...thread, deletedAt: now, goal: { ...t3Goal, current: null } },
  });
  assert.deepEqual(yield* store.getGoalThreads(), []);
});
it.effect("discovers only due goals and unfinished work in SQLite", () =>
  discoveryBehavior.pipe(
    Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  ),
);
it.effect("discovers the same due goals in memory", () =>
  discoveryBehavior.pipe(Effect.provide(ProjectionStore.layerMemory)),
);
