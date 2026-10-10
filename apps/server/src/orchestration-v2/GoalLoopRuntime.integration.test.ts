import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as GoalLoopWorker from "./GoalLoopWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

// Opt-in private evidence only. Normal CI always runs the synthetic disk-reopen case.
// The marker and empty executable/auth tables reject an unsanitized live snapshot.
const copiedDatabase = process.env.T3_FORK_COPIED_RUNTIME_DB;
const copiedFixture = (() => {
  if (copiedDatabase === undefined) return undefined;
  assert.isTrue(copiedDatabase.endsWith("/sanitized-goal-runtime.sqlite"));
  const db = new NodeSqlite.DatabaseSync(copiedDatabase, { readOnly: true });
  try {
    for (const table of [
      "auth_sessions",
      "auth_pairing_links",
      "scheduled_tasks",
      "provider_session_runtime",
      "orchestration_v2_thread_launch_workflows",
      "orchestration_v2_effect_outbox",
    ]) {
      assert.strictEqual(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count, 0);
    }
    const row = db.prepare("SELECT * FROM fork_runtime_fixture").get()!;
    assert.isString(row.owner_id);
    assert.isString(row.goal_id);
    assert.isString(row.workspace);
    assert.isNumber(row.historical_iteration);
    const workspace = String(row.workspace);
    return {
      threadId: ThreadId.make(String(row.owner_id)),
      goalId: CommandId.make(String(row.goal_id)),
      cwd: workspace,
      iteration: Number(row.historical_iteration),
    };
  } finally {
    db.close();
  }
})();

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fake-goal-model" };

// The production effect worker, provider session manager, event ingestor and
// orchestrator run here. Only the provider protocol, VCS and check process are fake.
const outcomes = [
  "complete",
  "stop",
  "delete",
  "restart",
  "disk-restart",
  "usage-limit",
  ...(copiedFixture === undefined ? [] : ["copied-restart"]),
] as const;
it.effect.each(outcomes)(
  "executes a goal through the effect worker and fake provider: %s",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const copied = outcome === "copied-restart" ? copiedFixture : undefined;
        const restart = outcome === "restart" || outcome === "disk-restart" || copied !== undefined;
        const cwd = copied?.cwd ?? (yield* checkpointWorkspace(`goal-runtime-${outcome}`));
        if (copied !== undefined) {
          assert.strictEqual(
            yield* fs.realPath(cwd),
            path.join(yield* fs.realPath(path.dirname(copiedDatabase!)), "workspace"),
          );
        }
        const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
        let answers = 0;
        let interrupts = 0;
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
              const now = yield* DateTime.now;
              let current: ProviderAdapter.ProviderAdapterV2TurnInput;
              const turnId = () => ProviderTurnId.make(`fake-turn:${current.attemptId}`);
              const request = (status: "pending" | "resolved") => ({
                id: RuntimeRequestId.make(`fake-request:${current.attemptId}`),
                nodeId: current.rootNodeId,
                providerTurnId: turnId(),
                nativeRequestRef: { driver, nativeId: "approval", strength: "strong" as const },
                kind: "command" as const,
                status,
                responseCapability: {
                  type: "live" as const,
                  providerSessionId: input.providerSessionId,
                },
                createdAt: now,
                resolvedAt: status === "pending" ? null : now,
              });
              const terminal = (status: "completed" | "interrupted") =>
                Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: current.providerThread.id,
                  providerTurnId: turnId(),
                  runOrdinal: current.runOrdinal,
                  status,
                  failure: null,
                  threadDisposition: "reusable",
                });
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: modelSelection.model,
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`fake-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    current = turn;
                    started.push(turn);
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: turnId(),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: { driver, nativeId: "turn", strength: "strong" },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                    if (outcome === "usage-limit") {
                      yield* Queue.offer(events, {
                        type: "turn.terminal",
                        driver,
                        providerThreadId: turn.providerThread.id,
                        providerTurnId: turnId(),
                        runOrdinal: turn.runOrdinal,
                        failureItemOrdinal: 2,
                        status: "failed",
                        failure: {
                          class: "usage_limit",
                          message: "Synthetic quota limit",
                          code: "quota",
                          retryable: true,
                          resetAt: null,
                        },
                        threadDisposition: "reusable",
                      });
                      return;
                    }
                    yield* Queue.offer(events, {
                      type: "runtime_request.updated",
                      driver,
                      threadId: turn.threadId,
                      runtimeRequest: request("pending"),
                    });
                  }),
                steerTurn: () => Effect.die("Unexpected steering in goal runtime test"),
                interruptTurn: () =>
                  Effect.gen(function* () {
                    interrupts += 1;
                    yield* terminal("interrupted");
                  }),
                respondToRuntimeRequest: () =>
                  Effect.gen(function* () {
                    answers += 1;
                    yield* Queue.offer(events, {
                      type: "runtime_request.updated",
                      driver,
                      threadId: current.threadId,
                      runtimeRequest: request("resolved"),
                    });
                    yield* terminal("completed");
                  }),
                readThreadSnapshot: () => Effect.die("Unexpected snapshot in goal runtime test"),
                rollbackThread: () => Effect.die("Unexpected rollback in goal runtime test"),
                forkThread: () => Effect.die("Unexpected fork in goal runtime test"),
              };
            }),
        };
        // Memory reconstruction borrows the outer connection. Disk cases acquire
        // and release a separate connection in each runtime scope. Use a fresh
        // migration layer so the outer memory setup cannot memoize it away.
        let diskConnections = 0;
        const database =
          outcome === "disk-restart" || copied !== undefined
            ? Layer.provideMerge(
                Layer.effectDiscard(
                  Effect.gen(function* () {
                    diskConnections += 1;
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        diskConnections -= 1;
                      }),
                    );
                    yield* runMigrations();
                  }),
                ),
                NodeSqliteClient.layer({
                  filename:
                    copiedDatabase && copied !== undefined
                      ? copiedDatabase
                      : path.join(cwd, "runtime.sqlite"),
                }),
              ).pipe(Layer.provide(NodeServices.layer))
            : Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient);
        const threadId = copied?.threadId ?? ThreadId.make(`goal-runtime:${outcome}`);
        const goalId = copied?.goalId ?? CommandId.make(`goal-runtime:${outcome}:set`);
        const loopDependencies = Layer.mergeAll(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([] as ServerProvider[]),
          }),
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ detect: () => Effect.succeed(null) }),
          Layer.mock(ProcessRunner.ProcessRunner)({ run: () => Effect.die("No check configured") }),
        );
        const runtime = (recoverOnStartup = false) =>
          Layer.mergeAll(
            ProviderReplayHarness.layerWithRegistry(
              { name: `goal-runtime-${outcome}` },
              ProviderAdapterRegistry.layerFromAdapters([adapter]),
              {
                databaseLayer: database,
                recoverOnStartup,
                continueThreadsAfterServerUpdate: false,
              },
            ),
            ProjectionStore.layer.pipe(Layer.provide(database)),
            ProjectStore.layer.pipe(Layer.provide(database)),
            EventStore.layer.pipe(Layer.provide(database)),
          );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const sink = yield* EventSink.EventSinkV2;
            const eventStore = yield* EventStore.EventStoreV2;
            const afterSequence = yield* eventStore.latestSequence();
            // Replays new persisted events before subscribing, without rescanning
            // the private historical transcript or racing provider ingestion.
            const wait = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
              sink.stream({ afterSequence }).pipe(
                Stream.filter(({ event }) => predicate(event)),
                Stream.take(1),
                Stream.runDrain,
              );
            const loop = yield* GoalLoopWorker.make.pipe(Effect.provide(loopDependencies));
            if (copied === undefined) {
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make("create"),
                threadId,
                projectId: ProjectId.make("goal-runtime"),
                title: "Runtime goal",
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: cwd,
                createdBy: "user",
                creationSource: "web",
              });
              yield* orchestrator.dispatch({
                type: "thread.goal.set",
                commandId: goalId,
                threadId,
                objective: "Exercise fake provider lifecycle",
                burnGuard: null,
              });
            } else {
              const historical = (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal!;
              assert.strictEqual(historical.iteration, copied.iteration);
              const oldChild = yield* orchestrator.getThreadProjection(
                historical.current!.childThreadId,
              );
              assert.isTrue(
                oldChild.runs.every(
                  (run) => !["running", "starting", "waiting", "preparing"].includes(run.status),
                ),
              );
              assert.isTrue(
                oldChild.runtimeRequests.every((request) => request.status !== "pending"),
              );
              yield* worker.drain();
              yield* loop.sweep();
              const recovered = (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal!;
              assert.strictEqual(recovered.status, "paused");
              assert.isNull(recovered.current);
              assert.lengthOf(started, 0);
              yield* orchestrator.dispatch({
                type: "thread.goal.control",
                commandId: CommandId.make("resume-copied-history"),
                threadId,
                goalId,
                action: "resume",
              });
            }
            yield* loop.sweep();
            const owner = (yield* orchestrator.getThreadRecords(threadId, [])).thread;
            const childId = owner.goal!.current!.childThreadId;
            yield* worker.drain();
            if (outcome === "usage-limit") {
              yield* wait(
                (event) =>
                  event.threadId === childId &&
                  event.type === "run.updated" &&
                  event.payload.status === "failed",
              );
              yield* worker.drain();
              yield* loop.sweep();
              const limited = (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal!;
              assert.strictEqual(limited.status, "usageLimited");
              assert.isNull(limited.current);
              assert.isNotNull(limited.resumeAt);
              assert.isTrue(
                Date.parse(limited.resumeAt!) > DateTime.toEpochMillis(yield* DateTime.now),
              );
              const reconstructed = yield* GoalLoopWorker.make.pipe(
                Effect.provide(loopDependencies),
              );
              yield* reconstructed.sweep();
              yield* worker.drain();
              assert.lengthOf(started, 1);
              return;
            }
            yield* wait(
              (event) =>
                event.threadId === childId &&
                event.type === "runtime-request.updated" &&
                event.payload.status === "pending",
            );
            yield* loop.sweep();
            const child = yield* orchestrator.getThreadProjection(childId);
            assert.lengthOf(started, 1);
            assert.isNull(child.thread.lineage.parentThreadId);
            assert.strictEqual(child.thread.goalIteration?.parentThreadId, threadId);
            if (copied === undefined)
              assert.strictEqual(
                (yield* orchestrator.getThreadProjection(threadId)).runs.length,
                0,
              );
            assert.isTrue(started.every((turn) => turn.threadId !== threadId));
            assert.isNotNull(
              (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal?.current
                ?.waitingOnRequest,
            );
            if (restart) return;
            if (outcome === "complete") {
              yield* orchestrator.dispatch({
                type: "thread.goal.report",
                commandId: CommandId.make("claim"),
                threadId,
                goalId,
                iteration: 1,
                childThreadId: childId,
                report: { type: "claim", status: "complete", summary: "Lifecycle passed" },
              });
              yield* orchestrator.dispatch({
                type: "runtime-request.respond",
                commandId: CommandId.make("answer"),
                threadId: childId,
                requestId: child.runtimeRequests[0]!.id,
                decision: "accept",
              });
            } else if (outcome === "delete") {
              yield* orchestrator.dispatch({
                type: "thread.delete",
                commandId: CommandId.make("delete-owner"),
                threadId,
              });
              yield* loop.sweep();
              yield* loop.sweep();
            } else {
              yield* orchestrator.dispatch({
                type: "thread.goal.control",
                commandId: CommandId.make("stop-owner"),
                threadId,
                goalId,
                action: "stop",
              });
              yield* loop.sweep();
            }
            yield* worker.drain();
            yield* wait(
              (event) =>
                event.threadId === childId &&
                event.type === "run.updated" &&
                event.payload.status === (outcome === "complete" ? "completed" : "interrupted"),
            );
            yield* worker.drain();
            yield* loop.sweep();
            const goal = (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal!;
            assert.strictEqual(goal.status, outcome === "complete" ? "complete" : "stopped");
            assert.isNull(goal.current);
            assert.strictEqual(answers, outcome === "complete" ? 1 : 0);
            assert.strictEqual(interrupts, outcome === "complete" ? 0 : 1);
            yield* loop.sweep();
            assert.lengthOf(started, 1);
            assert.strictEqual(
              (yield* orchestrator.getThreadProjection(childId)).runtimeRequests[0]?.status,
              outcome === "complete" ? "resolved" : "cancelled",
            );
          }).pipe(Effect.provide(runtime(copied !== undefined))),
        );
        if (restart) {
          assert.strictEqual(diskConnections, 0);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              const sink = yield* EventSink.EventSinkV2;
              const eventStore = yield* EventStore.EventStoreV2;
              const afterSequence = yield* eventStore.latestSequence();
              if (outcome === "disk-restart" || copied !== undefined)
                assert.strictEqual(diskConnections, 1);
              const before = (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal!;
              assert.strictEqual(before.iteration, (copied?.iteration ?? 0) + 1);
              const oldChild = yield* orchestrator.getThreadProjection(
                before.current!.childThreadId,
              );
              assert.isTrue(
                oldChild.runs.every(
                  (run) => !["running", "starting", "waiting"].includes(run.status),
                ),
              );
              assert.isTrue(
                oldChild.runtimeRequests.every((request) => request.status !== "pending"),
              );
              const loop = yield* GoalLoopWorker.make.pipe(Effect.provide(loopDependencies));
              yield* worker.drain();
              yield* loop.sweep();
              const recovered = (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal!;
              assert.isNull(recovered.current);
              assert.strictEqual(recovered.status, "paused");
              assert.lengthOf(started, 1);
              yield* orchestrator.dispatch({
                type: "thread.goal.control",
                commandId: CommandId.make("resume-after-restart"),
                threadId,
                goalId,
                action: "resume",
              });
              yield* loop.sweep();
              const second = (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal!;
              assert.strictEqual(second.iteration, (copied?.iteration ?? 0) + 2);
              const childId = second.current!.childThreadId;
              assert.notStrictEqual(childId, oldChild.thread.id);
              yield* worker.drain();
              yield* sink.stream({ afterSequence }).pipe(
                Stream.filter(
                  ({ event }) =>
                    event.threadId === childId &&
                    event.type === "runtime-request.updated" &&
                    event.payload.status === "pending",
                ),
                Stream.take(1),
                Stream.runDrain,
              );
              assert.lengthOf(started, 2);
              yield* orchestrator.dispatch({
                type: "thread.goal.control",
                commandId: CommandId.make("stop-restarted-goal"),
                threadId,
                goalId,
                action: "stop",
              });
              yield* loop.sweep();
              yield* worker.drain();
              yield* sink.stream({ afterSequence }).pipe(
                Stream.filter(
                  ({ event }) =>
                    event.threadId === childId &&
                    event.type === "run.updated" &&
                    event.payload.status === "interrupted",
                ),
                Stream.take(1),
                Stream.runDrain,
              );
              yield* worker.drain();
              yield* loop.sweep();
              const stopped = (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal!;
              assert.strictEqual(stopped.status, "stopped");
              assert.isNull(stopped.current);
              yield* loop.sweep();
              assert.lengthOf(started, 2);
              assert.isTrue(
                (yield* orchestrator.getThreadProjection(childId)).runtimeRequests.every(
                  (request) => request.status !== "pending",
                ),
              );
            }).pipe(Effect.provide(runtime(true))),
          );
          assert.strictEqual(diskConnections, 0);
        }
      }).pipe(Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer))),
    ),
);
