import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Path from "effect/Path";
import { runMigrations } from "../persistence/Migrations.ts";
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
import * as GoalLoopWorker from "./GoalLoopWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fake-goal-model" };

// The production effect worker, provider session manager, event ingestor and
// orchestrator run here. Only the provider protocol, VCS and check process are fake.
it.effect.each(["complete", "stop", "delete", "restart", "disk-restart", "usage-limit"] as const)(
  "executes a goal through the effect worker and fake provider: %s",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`goal-runtime-${outcome}`);
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
        // Memory reconstruction borrows the outer connection. Disk reconstruction
        // acquires and releases a connection inside each runtime scope. A fresh
        // migration layer avoids memoization of the outer memory setup.
        const path = yield* Path.Path;
        const database =
          outcome === "disk-restart"
            ? Layer.provideMerge(
                Layer.effectDiscard(runMigrations()),
                NodeSqliteClient.layer({ filename: path.join(cwd, "runtime.sqlite") }),
              ).pipe(Layer.provide(NodeServices.layer))
            : Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient);
        const threadId = ThreadId.make(`goal-runtime:${outcome}`);
        const goalId = CommandId.make(`goal-runtime:${outcome}:set`);
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
          );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const sink = yield* EventSink.EventSinkV2;
            // Replays persisted events before subscribing, so no sleep or race with provider ingestion.
            const wait = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
              sink.stream().pipe(
                Stream.filter(({ event }) => predicate(event)),
                Stream.take(1),
                Stream.runDrain,
              );
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
            const loop = yield* GoalLoopWorker.make.pipe(Effect.provide(loopDependencies));
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
            assert.strictEqual((yield* orchestrator.getThreadProjection(threadId)).runs.length, 0);
            assert.isNotNull(
              (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal?.current
                ?.waitingOnRequest,
            );
            if (outcome === "restart" || outcome === "disk-restart") return;
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
          }).pipe(Effect.provide(runtime())),
        );
        if (outcome === "restart" || outcome === "disk-restart") {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              const sink = yield* EventSink.EventSinkV2;
              const before = (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal!;
              assert.strictEqual(before.iteration, 1);
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
              assert.strictEqual(second.iteration, 2);
              const childId = second.current!.childThreadId;
              assert.notStrictEqual(childId, oldChild.thread.id);
              yield* worker.drain();
              yield* sink.stream().pipe(
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
            }).pipe(Effect.provide(runtime(true))),
          );
        }
      }).pipe(Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeServices.layer))),
    ),
);
