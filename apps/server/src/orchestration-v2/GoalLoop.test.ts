import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  type ServerProvider,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as GoalLoopWorker from "./GoalLoopWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for goal command tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const TestLayer = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "goal-loop" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const setup = Effect.fn("GoalLoopTest.setup")(function* (
  name: string,
  goal: {
    readonly checkCommand?: string;
    readonly noProgressLimit?: number;
    readonly iterationTimeoutMins?: number;
  } = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectId = ProjectId.make(`project:${name}`);
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:create:${threadId}`),
    threadId,
    projectId,
    title: "Goal owner",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  const goalId = CommandId.make(`command:${name}:goal`);
  yield* orchestrator.dispatch({
    type: "thread.goal.set",
    commandId: goalId,
    threadId,
    objective: "Make every test pass",
    ...goal,
  });
  return { orchestrator, threadId, goalId };
});

it.layer(TestLayer)("goal commands", (it) => {
  it.effect("rejects stale update recovery after a subsequent user pause", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, goalId } = yield* setup("update-pause-identity");
      const pauseId = CommandId.make("update:pause");
      yield* orchestrator.dispatch({
        type: "thread.goal.control",
        commandId: pauseId,
        threadId,
        goalId,
        action: "pause",
      });
      assert.strictEqual(
        (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal?.lastControlCommandId,
        pauseId,
      );
      // A repeated user Pause must invalidate automatic recovery even with the same clock.
      yield* orchestrator.dispatch({
        type: "thread.goal.control",
        commandId: CommandId.make("user:pause"),
        threadId,
        goalId,
        action: "pause",
      });
      const stale = yield* orchestrator
        .dispatch({
          type: "thread.goal.control",
          commandId: CommandId.make("update:resume:stale"),
          threadId,
          goalId,
          action: "resume",
          expectedControlCommandId: pauseId,
        })
        .pipe(Effect.result);
      assert.strictEqual(stale._tag, "Failure");
      assert.strictEqual(
        (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal?.status,
        "paused",
      );
      yield* orchestrator.dispatch({
        type: "thread.goal.control",
        commandId: CommandId.make("user:resume"),
        threadId,
        goalId,
        action: "resume",
      });
      yield* orchestrator.dispatch({
        type: "thread.goal.control",
        commandId: CommandId.make("update:pause:2"),
        threadId,
        goalId,
        action: "pause",
      });
      yield* orchestrator.dispatch({
        type: "thread.goal.control",
        commandId: CommandId.make("update:resume:2"),
        threadId,
        goalId,
        action: "resume",
        expectedControlCommandId: CommandId.make("update:pause:2"),
      });
      assert.strictEqual(
        (yield* orchestrator.getThreadRecords(threadId, [])).thread.goal?.status,
        "active",
      );
    }),
  );

  it.effect(
    "rejects automatic settlement of a live goal even with a matching snapshot timestamp",
    () =>
      Effect.gen(function* () {
        const { orchestrator, threadId } = yield* setup("goal-settlement");
        const thread = (yield* orchestrator.getThreadRecords(threadId, [])).thread;
        const result = yield* orchestrator
          .dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make("goal:auto-settle"),
            threadId,
            snapshotAt: thread.updatedAt,
          })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.isNull((yield* orchestrator.getThreadShell(threadId))?.settledOverride);
      }),
  );

  it.effect("starts an iteration in a fresh top-level thread", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, goalId } = yield* setup("goal-start");
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.deepInclude(shell?.t3Goal, { id: goalId, status: "active", iteration: 0 });

      yield* orchestrator.dispatch({
        type: "thread.goal.iteration.start",
        commandId: CommandId.make(`goal:${goalId}:1:start`),
        threadId,
        goalId,
        iteration: 1,
        baselineRef: null,
        prompt: "Iteration 1: make every test pass.",
      });

      const parent = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
      const current = parent.thread.goal?.current;
      assert.isDefined(current);
      assert.strictEqual(current?.iteration, 1);
      // The parent agent is never woken: no run or message lands on the parent.
      assert.lengthOf(parent.runs, 0);
      assert.lengthOf(parent.messages, 0);

      const child = yield* orchestrator.getThreadRecords(current!.childThreadId, [
        "runs",
        "messages",
      ]);
      assert.isNull(child.thread.forkedFrom);
      assert.deepEqual(child.thread.lineage, {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: child.thread.id,
      });
      assert.isNull(child.thread.goal);
      assert.deepEqual(child.thread.pullRequests, []);
      assert.deepEqual(child.thread.goalIteration, {
        parentThreadId: threadId,
        goalId,
        iteration: 1,
      });
      assert.lengthOf(child.runs, 1);
      assert.strictEqual(child.messages[0]?.text, "Iteration 1: make every test pass.");
      assert.isUndefined(child.messages[0]?.senderThreadId);
    }),
  );

  it.effect("records child reports and closes the iteration", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, goalId } = yield* setup("goal-report");
      yield* orchestrator.dispatch({
        type: "thread.goal.iteration.start",
        commandId: CommandId.make(`goal:${goalId}:1:start`),
        threadId,
        goalId,
        iteration: 1,
        baselineRef: null,
        prompt: "Iteration 1.",
      });
      const childThreadId = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).thread.goal!
        .current!.childThreadId;
      yield* orchestrator.dispatch({
        type: "thread.goal.report",
        commandId: CommandId.make("command:goal-report:note"),
        threadId,
        goalId,
        iteration: 1,
        childThreadId,
        report: { type: "claim", status: "complete", summary: "All tests pass" },
      });
      yield* orchestrator.dispatch({
        type: "thread.goal.advance",
        commandId: CommandId.make("command:goal-report:finish"),
        threadId,
        goalId,
        iteration: 1,
        step: {
          type: "iteration_finished",
          childOutcome: "completed",
          tokens: 4_200,
          accounting: "exact",
          workspaceChanged: true,
          resumeAt: null,
        },
      });
      const goal = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).thread.goal;
      assert.deepInclude(goal, {
        status: "complete",
        completedSummary: "All tests pass",
        tokensUsed: 4_200,
        current: null,
      });

      yield* orchestrator.dispatch({
        type: "thread.goal.control",
        commandId: CommandId.make("command:goal-report:clear"),
        threadId,
        goalId,
        action: "clear",
      });
      assert.isNull((yield* orchestrator.getThreadShell(threadId))?.t3Goal);
    }),
  );

  it.effect("holds an agent's goal proposal until a goal starts", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, goalId } = yield* setup("goal-proposal");
      const propose = (suffix: string) =>
        orchestrator.dispatch({
          type: "thread.goal.propose",
          commandId: CommandId.make(`command:goal-proposal:${suffix}`),
          threadId,
          objective: "Migrate every package to the new API",
          doneWhen: "No package imports the old API",
          background: "The new API lives in packages/api.",
          checkCommand: null,
          permissions: null,
          iterationTimeoutMins: null,
          reason: null,
        });

      // A thread that already runs a goal cannot propose another.
      const rejected = yield* propose("live").pipe(Effect.result);
      assert.strictEqual(rejected._tag, "Failure");

      yield* orchestrator.dispatch({
        type: "thread.goal.control",
        commandId: CommandId.make("command:goal-proposal:stop"),
        threadId,
        goalId,
        action: "stop",
      });
      yield* propose("first");
      assert.deepInclude((yield* orchestrator.getThreadShell(threadId))?.goalProposal, {
        id: CommandId.make("command:goal-proposal:first"),
        objective: "Migrate every package to the new API",
        doneWhen: "No package imports the old API",
      });

      yield* orchestrator.dispatch({
        type: "thread.goal.proposal.dismiss",
        commandId: CommandId.make("command:goal-proposal:dismiss"),
        threadId,
        proposalId: CommandId.make("command:goal-proposal:first"),
      });
      assert.isNull((yield* orchestrator.getThreadShell(threadId))?.goalProposal);

      yield* propose("second");
      yield* orchestrator.dispatch({
        type: "thread.goal.control",
        commandId: CommandId.make("command:goal-proposal:clear"),
        threadId,
        goalId,
        action: "clear",
      });
      yield* orchestrator.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make("command:goal-proposal:start"),
        threadId,
        objective: "Migrate every package to the new API",
        doneWhen: "No package imports the old API",
      });
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.isNull(shell?.goalProposal);
      assert.strictEqual(shell?.t3Goal?.status, "active");
    }),
  );

  it.effect("edits a paused goal's brief and shows it on the shell", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, goalId } = yield* setup("goal-update");
      const update = {
        type: "thread.goal.update" as const,
        threadId,
        goalId,
        objective: "Make every test pass and merge",
        permissions: "Merge the PR once CI is green",
      };
      const whileActive = yield* orchestrator
        .dispatch({ ...update, commandId: CommandId.make("goal-update:active") })
        .pipe(Effect.result);
      assert.strictEqual(whileActive._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "thread.goal.control",
        commandId: CommandId.make("goal-update:pause"),
        threadId,
        goalId,
        action: "pause",
      });
      yield* orchestrator.dispatch({ ...update, commandId: CommandId.make("goal-update:edit") });
      assert.deepInclude((yield* orchestrator.getThreadRecords(threadId, [])).thread.goal, {
        objective: "Make every test pass and merge",
        permissions: "Merge the PR once CI is green",
        status: "paused",
        lastControlCommandId: CommandId.make("goal-update:pause"),
      });
      assert.strictEqual(
        (yield* orchestrator.getThreadShell(threadId))?.t3Goal?.objective,
        "Make every test pass and merge",
      );
    }),
  );

  it.effect("rejects a stale iteration start", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, goalId } = yield* setup("goal-stale");
      const result = yield* orchestrator
        .dispatch({
          type: "thread.goal.iteration.start",
          commandId: CommandId.make(`goal:${goalId}:2:start`),
          threadId,
          goalId,
          iteration: 2,
          baselineRef: null,
          prompt: "Iteration 2.",
        })
        .pipe(Effect.flip);
      assert.strictEqual(result._tag, "OrchestratorDispatchError");
      assert.match(
        String((result as { readonly cause?: unknown }).cause),
        /Stale iteration number/,
      );
    }),
  );
});

const checkResults: Array<{ readonly code: number; readonly stdout: string }> = [];
let usageWindows: ServerProvider["usageLimits"] = undefined;

const WorkerDependencies = Layer.mergeAll(
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.sync(() => [
      { instanceId: modelSelection.instanceId, usageLimits: usageWindows } as ServerProvider,
    ]),
  }),
  Layer.mock(ProcessRunner.ProcessRunner)({
    run: () =>
      Effect.sync(() => {
        const result = checkResults.shift() ?? { code: 0, stdout: "" };
        return {
          stdout: result.stdout,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(result.code),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  }),
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ detect: () => Effect.succeed(null) }),
);

const goalLoop = GoalLoopWorker.make.pipe(Effect.provide(WorkerDependencies));

const readGoal = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.getThreadRecords(threadId, ["runs"])),
    Effect.map((records) => records.thread.goal!),
  );

/** Ends the current iteration's latest child run with `status`. */
const completeChildRun = Effect.fn("GoalLoopTest.completeChildRun")(function* (
  childThreadId: ThreadId,
  status: "completed" | "interrupted" = "completed",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const run = (yield* orchestrator.getThreadRecords(childThreadId, ["runs"])).runs.at(-1)!;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:${run.id}:${status}`),
        type: "run.updated",
        threadId: childThreadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status, startedAt: run.startedAt ?? now, completedAt: now },
      },
    ],
  });
});

/**
 * Records the latest child run's provider turn with `usedTokens` of a
 * 100k context window in use, 1k of its input uncached plus 100 output.
 */
const reportTurnUsage = Effect.fn("GoalLoopTest.reportTurnUsage")(function* (
  childThreadId: ThreadId,
  usedTokens: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const runs = (yield* orchestrator.getThreadRecords(childThreadId, ["runs"])).runs;
  const run = runs.at(-1)!;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:${run.id}:turn-usage`),
        type: "provider-turn.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`turn:${run.id}`),
          providerThreadId: run.providerThreadId!,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId,
          nativeTurnRef: null,
          ordinal: runs.length,
          status: "completed",
          startedAt: now,
          completedAt: now,
          tokenUsage: { usedTokens, maxTokens: 100_000, updatedAt: DateTime.formatIso(now) },
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: usedTokens,
            cachedInputTokens: usedTokens - 1_000,
            outputTokens: 100,
            hasSubagents: false,
          },
        },
      },
    ],
  });
});

const reportFromChild = (
  threadId: ThreadId,
  goalId: CommandId,
  report:
    | { readonly type: "note"; readonly text: string }
    | {
        readonly type: "claim";
        readonly status: "complete" | "blocked";
        readonly summary: string;
      },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const goal = yield* readGoal(threadId);
    yield* orchestrator.dispatch({
      type: "thread.goal.report",
      commandId: CommandId.make(
        `command:report:${threadId}:${goal.iteration}:${report.type === "note" ? report.text : report.status}`,
      ),
      threadId,
      goalId,
      iteration: goal.iteration,
      childThreadId: goal.current!.childThreadId,
      report,
    });
  });

it.layer(TestLayer)("goal loop worker", (it) => {
  it.effect.each(["thread.archive", "thread.delete"] as const)(
    "%s cleans up the top-level iteration without launching more work",
    (type) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { orchestrator, threadId } = yield* setup(`loop-owner:${type}`);
          const loop = yield* goalLoop;
          yield* loop.sweep();
          const childId = (yield* readGoal(threadId)).current!.childThreadId;
          yield* orchestrator.dispatch({ type, commandId: CommandId.make(type), threadId });
          for (let i = 0; i < 4; i++) yield* loop.sweep();
          assert.deepInclude(yield* readGoal(threadId), {
            status: "stopped",
            statusReason: "parent_unavailable",
            current: null,
            iteration: 1,
          });
          const child = yield* orchestrator.getThreadRecords(childId, ["runs"]);
          assert.deepEqual(
            child.runs.map((run) => run.status),
            ["interrupted"],
          );
          assert.isNull(child.thread.lineage.parentThreadId);
        }),
      ),
  );

  it.effect("Stop cancels a waiting iteration and its pending provider request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { orchestrator, threadId, goalId } = yield* setup("loop-stop-waiting");
        const loop = yield* goalLoop;
        yield* loop.sweep();
        const childId = (yield* readGoal(threadId)).current!.childThreadId;
        const records = yield* orchestrator.getThreadRecords(childId, ["runs", "attempts"]);
        const run = records.runs[0]!;
        const attempt = records.attempts[0]!;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const providerTurnId = ProviderTurnId.make("turn:waiting-goal");
        yield* sink.write({
          events: [
            {
              id: EventId.make("waiting-goal:run"),
              type: "run.updated",
              threadId: childId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "waiting", startedAt: now },
            },
            {
              id: EventId.make("waiting-goal:attempt"),
              type: "run-attempt.updated",
              threadId: childId,
              runId: run.id,
              occurredAt: now,
              payload: { ...attempt, status: "running", startedAt: now, providerTurnId },
            },
            {
              id: EventId.make("waiting-goal:turn"),
              type: "provider-turn.updated",
              threadId: childId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId: run.providerThreadId!,
                nodeId: run.rootNodeId!,
                runAttemptId: attempt.id,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make("waiting-goal:request"),
              type: "runtime-request.updated",
              threadId: childId,
              occurredAt: now,
              payload: {
                id: RuntimeRequestId.make("request:waiting-goal"),
                nodeId: run.rootNodeId!,
                providerTurnId,
                nativeRequestRef: null,
                kind: "command",
                status: "pending",
                responseCapability: { type: "not_resumable", reason: "Fake provider is offline" },
                createdAt: now,
                resolvedAt: null,
              },
            },
          ],
        });
        yield* loop.sweep();
        assert.isNotNull((yield* readGoal(threadId)).current?.waitingOnRequest);
        yield* orchestrator.dispatch({
          type: "thread.goal.control",
          commandId: CommandId.make("stop:waiting-goal"),
          threadId,
          goalId,
          action: "stop",
        });
        yield* loop.sweep();
        yield* loop.sweep();
        const stopped = yield* orchestrator.getThreadRecords(childId, ["runs", "runtimeRequests"]);
        assert.strictEqual(stopped.runs[0]?.status, "interrupted");
        assert.strictEqual(stopped.runtimeRequests[0]?.status, "cancelled");
        assert.deepInclude(yield* readGoal(threadId), { status: "stopped", current: null });
      }),
    ),
  );

  it.effect("Stop interrupts an in-flight completion check before clearing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { orchestrator, threadId, goalId } = yield* setup("loop-stop-check", {
          checkCommand: "long-check",
        });
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const loop = yield* GoalLoopWorker.make.pipe(
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            ProcessRunner.ProcessRunner.of({
              run: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                ),
            }),
          ),
          Effect.provide(WorkerDependencies),
        );
        yield* loop.sweep();
        yield* reportFromChild(threadId, goalId, {
          type: "claim",
          status: "complete",
          summary: "Ready",
        });
        yield* completeChildRun((yield* readGoal(threadId)).current!.childThreadId);
        yield* loop.sweep();
        yield* loop.sweep();
        yield* Deferred.await(started);
        yield* orchestrator.dispatch({
          type: "thread.goal.control",
          commandId: CommandId.make("stop:check"),
          threadId,
          goalId,
          action: "stop",
        });
        yield* loop.sweep();
        yield* Deferred.await(interrupted);
        yield* loop.awaitChecks;
        assert.deepInclude(yield* readGoal(threadId), { status: "stopped", current: null });
        assert.strictEqual((yield* readGoal(threadId)).lastCheck?.passed, false);
      }),
    ),
  );

  it.effect("reconstructs a check interrupted by worker teardown from durable state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { threadId, goalId } = yield* setup("loop-check-teardown", {
          checkCommand: "restart-check",
        });
        const setupWorker = yield* goalLoop;
        yield* setupWorker.sweep();
        yield* reportFromChild(threadId, goalId, {
          type: "claim",
          status: "complete",
          summary: "Verified",
        });
        yield* completeChildRun((yield* readGoal(threadId)).current!.childThreadId);
        yield* setupWorker.sweep();
        const entered = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* GoalLoopWorker.make.pipe(
              Effect.provideService(
                ProcessRunner.ProcessRunner,
                ProcessRunner.ProcessRunner.of({
                  run: () =>
                    Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
                    ),
                }),
              ),
              Effect.provide(WorkerDependencies),
            );
            yield* worker.sweep();
            yield* Deferred.await(entered);
          }),
        );
        yield* Deferred.await(cancelled);
        assert.deepInclude(yield* readGoal(threadId), { status: "active", iteration: 1 });
        assert.strictEqual((yield* readGoal(threadId)).current?.phase, "checking");
        checkResults.push({ code: 0, stdout: "restarted check passed" });
        const restarted = yield* goalLoop;
        yield* restarted.sweep();
        yield* restarted.awaitChecks;
        assert.deepInclude(yield* readGoal(threadId), {
          status: "complete",
          iteration: 1,
          current: null,
        });
        assert.strictEqual((yield* readGoal(threadId)).lastCheck?.passed, true);
      }),
    ),
  );

  it.effect(
    "backs off a limited iteration across reconstruction and resumes through the owner only",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { orchestrator, threadId } = yield* setup("loop-usage-limit");
          const loop = yield* goalLoop;
          yield* loop.sweep();
          const childThreadId = (yield* readGoal(threadId)).current!.childThreadId;
          const run = (yield* orchestrator.getThreadRecords(childThreadId, ["runs"])).runs[0]!;
          const now = yield* DateTime.now;
          const resetAt = DateTime.formatIso(
            DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 60_000),
          );
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("limit:run"),
                type: "run.updated",
                threadId: childThreadId,
                occurredAt: now,
                payload: { ...run, status: "failed", startedAt: now, completedAt: now },
              },
              {
                id: EventId.make("limit:error"),
                type: "turn-item.updated",
                threadId: childThreadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("limit:error"),
                  type: "error",
                  threadId: childThreadId,
                  runId: run.id,
                  nodeId: run.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "failed",
                  title: "Usage limit",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  failure: {
                    class: "usage_limit",
                    message: "Plan limit",
                    code: "usageLimitExceeded",
                    retryable: null,
                    resetAt,
                  },
                },
              },
            ],
          });
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          assert.deepEqual(
            yield* projections.getLimitRecoveryCandidates({ now, autoResume: true, snooze: true }),
            [],
          );
          yield* loop.sweep();
          assert.deepInclude(yield* readGoal(threadId), {
            status: "usageLimited",
            resumeAt: resetAt,
            current: null,
          });
          const restartedWorker = yield* goalLoop;
          yield* restartedWorker.sweep();
          assert.strictEqual((yield* readGoal(threadId)).iteration, 1);
          yield* TestClock.adjust("1 minute");
          yield* restartedWorker.sweep();
          assert.strictEqual((yield* readGoal(threadId)).status, "active");
          yield* restartedWorker.sweep();
          assert.strictEqual((yield* readGoal(threadId)).iteration, 2);
        }),
      ),
  );

  it.effect(
    "resumes from persisted iteration state in a fresh worker without reusing receipts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { threadId, goalId } = yield* setup("loop-restart");
          const firstWorker = yield* goalLoop;
          yield* firstWorker.sweep();
          const firstChild = (yield* readGoal(threadId)).current!.childThreadId;
          yield* reportFromChild(threadId, goalId, {
            type: "note",
            text: "Checkpointed the parser",
          });
          yield* completeChildRun(firstChild);
          const restartedWorker = yield* goalLoop;
          yield* restartedWorker.sweep();
          assert.isNull((yield* readGoal(threadId)).current);
          yield* restartedWorker.sweep();
          const goal = yield* readGoal(threadId);
          assert.strictEqual(goal.iteration, 2);
          assert.notEqual(goal.current!.childThreadId, firstChild);
          yield* restartedWorker.sweep();
          assert.strictEqual((yield* readGoal(threadId)).iteration, 2);
        }),
      ),
  );

  it.effect("restarts a pending completion check and completes only after a passing result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { threadId, goalId } = yield* setup("loop-check-restart", {
          checkCommand: "candidate-check",
        });
        const firstWorker = yield* goalLoop;
        yield* firstWorker.sweep();
        yield* reportFromChild(threadId, goalId, {
          type: "claim",
          status: "complete",
          summary: "Candidate ready",
        });
        yield* completeChildRun((yield* readGoal(threadId)).current!.childThreadId);
        yield* firstWorker.sweep();
        assert.strictEqual((yield* readGoal(threadId)).current?.phase, "checking");
        assert.strictEqual((yield* readGoal(threadId)).status, "active");
        const restartedWorker = yield* goalLoop;
        checkResults.push({ code: 0, stdout: "passed" });
        yield* restartedWorker.sweep();
        yield* restartedWorker.awaitChecks;
        assert.deepInclude(yield* readGoal(threadId), { status: "complete", current: null });
        assert.strictEqual((yield* readGoal(threadId)).lastCheck?.passed, true);
      }),
    ),
  );

  it.effect("honors a paused owner across worker reconstruction and starts once on resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { orchestrator, threadId, goalId } = yield* setup("loop-pause-restart");
        for (const suffix of ["first", "again"]) {
          yield* orchestrator.dispatch({
            type: "thread.goal.control",
            commandId: CommandId.make(`pause:${suffix}`),
            threadId,
            goalId,
            action: "pause",
          });
        }
        const restartedWorker = yield* goalLoop;
        yield* restartedWorker.sweep();
        assert.strictEqual((yield* readGoal(threadId)).iteration, 0);
        yield* orchestrator.dispatch({
          type: "thread.goal.control",
          commandId: CommandId.make("resume:once"),
          threadId,
          goalId,
          action: "resume",
        });
        yield* restartedWorker.sweep();
        yield* restartedWorker.sweep();
        assert.strictEqual((yield* readGoal(threadId)).iteration, 1);
      }),
    ),
  );

  it.effect("stops a queued iteration and never launches another", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { orchestrator, threadId, goalId } = yield* setup("loop-stop");
        const loop = yield* goalLoop;
        yield* loop.sweep();
        const childThreadId = (yield* readGoal(threadId)).current!.childThreadId;
        yield* orchestrator.dispatch({
          type: "thread.goal.control",
          commandId: CommandId.make("stop:owner"),
          threadId,
          goalId,
          action: "stop",
        });
        yield* loop.sweep();
        const child = yield* orchestrator.getThreadRecords(childThreadId, ["runs"]);
        assert.isTrue(child.runs.every((run) => run.status !== "queued" || run.queueHeld === true));
        yield* loop.sweep();
        assert.deepInclude(yield* readGoal(threadId), {
          status: "stopped",
          current: null,
          iteration: 1,
        });
        yield* loop.sweep();
        assert.strictEqual((yield* readGoal(threadId)).iteration, 1);
      }),
    ),
  );

  it.effect("runs iterations until the agent claims completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { orchestrator, threadId, goalId } = yield* setup("loop-basic");
        const loop = yield* goalLoop;

        yield* loop.sweep();
        const first = yield* readGoal(threadId);
        assert.strictEqual(first.iteration, 1);
        const firstChild = first.current!.childThreadId;
        // A second sweep while the child works starts nothing new.
        yield* loop.sweep();
        assert.strictEqual((yield* readGoal(threadId)).iteration, 1);

        yield* reportFromChild(threadId, goalId, { type: "note", text: "Fixed the parser" });
        yield* completeChildRun(firstChild);
        yield* loop.sweep();
        const afterFirst = yield* readGoal(threadId);
        assert.isNull(afterFirst.current);
        assert.deepInclude(afterFirst.history[0], { iteration: 1, outcome: "continued" });
        const settledChild = yield* orchestrator.getThreadShell(firstChild);
        assert.strictEqual(settledChild?.settledOverride, "settled");

        yield* loop.sweep();
        const second = yield* readGoal(threadId);
        assert.strictEqual(second.iteration, 2);
        const secondChild = yield* orchestrator.getThreadRecords(second.current!.childThreadId, [
          "messages",
        ]);
        assert.include(secondChild.messages[0]?.text, "[iteration 1] Fixed the parser");

        yield* reportFromChild(threadId, goalId, {
          type: "claim",
          status: "complete",
          summary: "Every test passes",
        });
        yield* completeChildRun(second.current!.childThreadId);
        yield* loop.sweep();
        assert.deepInclude(yield* readGoal(threadId), {
          status: "complete",
          completedSummary: "Every test passes",
        });
      }),
    ),
  );

  it.effect("continues a turn in place while context has room, then rolls over", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { orchestrator, threadId, goalId } = yield* setup("loop-rollover");
        const loop = yield* goalLoop;
        yield* loop.sweep();
        const childThreadId = (yield* readGoal(threadId)).current!.childThreadId;

        // 30 % of the window used and a note recorded: the same thread goes on.
        yield* reportTurnUsage(childThreadId, 30_000);
        yield* reportFromChild(threadId, goalId, { type: "note", text: "Parser done" });
        yield* completeChildRun(childThreadId);
        yield* loop.sweep();
        const continued = yield* readGoal(threadId);
        assert.deepInclude(continued.current, { childThreadId, continuations: 1 });
        const child = yield* orchestrator.getThreadRecords(childThreadId, ["runs", "messages"]);
        assert.lengthOf(child.runs, 2);
        assert.include(child.messages.at(-1)?.text, "Continue from T3 Code");
        yield* loop.sweep();
        assert.strictEqual((yield* readGoal(threadId)).current?.continuations, 1);

        // Past 60 %, the iteration ends and the next one starts fresh.
        yield* reportTurnUsage(childThreadId, 65_000);
        yield* reportFromChild(threadId, goalId, { type: "note", text: "Writer done" });
        yield* completeChildRun(childThreadId);
        yield* loop.sweep();
        const rolled = yield* readGoal(threadId);
        assert.isNull(rolled.current);
        assert.deepInclude(rolled.history.at(-1), {
          outcome: "continued",
          continuations: 1,
          tokens: 30_100 + 65_100,
          uncachedTokens: 2_200,
        });
        assert.deepInclude(rolled, { tokensUsed: 95_200, uncachedTokensUsed: 2_200 });
        yield* loop.sweep();
        const next = yield* readGoal(threadId);
        assert.strictEqual(next.iteration, 2);
        assert.notStrictEqual(next.current?.childThreadId, childThreadId);
      }),
    ),
  );

  it.effect("hands a turn without a note to a fresh iteration even with context to spare", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { threadId } = yield* setup("loop-silent-turn");
        const loop = yield* goalLoop;
        yield* loop.sweep();
        const childThreadId = (yield* readGoal(threadId)).current!.childThreadId;
        yield* reportTurnUsage(childThreadId, 10_000);
        yield* completeChildRun(childThreadId);
        yield* loop.sweep();
        const goal = yield* readGoal(threadId);
        assert.isNull(goal.current);
        assert.isUndefined(goal.history.at(-1)?.continuations);
      }),
    ),
  );

  it.effect("keeps going when the completion check fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { threadId, goalId } = yield* setup("loop-check", { checkCommand: "pnpm test" });
        const loop = yield* goalLoop;
        checkResults.push({ code: 1, stdout: "2 failing" });

        yield* loop.sweep();
        yield* reportFromChild(threadId, goalId, {
          type: "claim",
          status: "complete",
          summary: "Done",
        });
        yield* completeChildRun((yield* readGoal(threadId)).current!.childThreadId);
        yield* loop.sweep();
        assert.strictEqual((yield* readGoal(threadId)).current?.phase, "checking");

        yield* loop.sweep();
        yield* loop.awaitChecks;
        const afterCheck = yield* readGoal(threadId);
        assert.deepInclude(afterCheck, { status: "active", current: null });
        assert.deepInclude(afterCheck.lastCheck, { passed: false, exitCode: 1 });

        yield* loop.sweep();
        const retry = yield* readGoal(threadId);
        const retryChild = yield* Orchestrator.OrchestratorV2.pipe(
          Effect.flatMap((orchestrator) =>
            orchestrator.getThreadRecords(retry.current!.childThreadId, ["messages"]),
          ),
        );
        assert.include(retryChild.messages[0]?.text, "2 failing");
      }),
    ),
  );

  it.effect("delivers a reply from the goal thread into the running iteration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { orchestrator, threadId, goalId } = yield* setup("loop-reply");
        const loop = yield* goalLoop;
        yield* loop.sweep();
        const childThreadId = (yield* readGoal(threadId)).current!.childThreadId;

        yield* orchestrator.dispatch({
          type: "thread.goal.message",
          commandId: CommandId.make("command:loop-reply:message"),
          threadId,
          goalId,
          text: "Use the staging bucket",
        });
        assert.lengthOf((yield* readGoal(threadId)).current?.pendingMessages ?? [], 1);

        yield* loop.sweep();
        assert.lengthOf((yield* readGoal(threadId)).current?.pendingMessages ?? [], 0);
        const child = yield* orchestrator.getThreadRecords(childThreadId, ["runs"]);
        assert.lengthOf(child.runs, 2);
      }),
    ),
  );

  it.effect("keeps a rejected wrap-up pending, enforces the time limit, and moves on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Below the floor, so the limit is 45 minutes.
        const { threadId } = yield* setup("loop-timeout", { iterationTimeoutMins: 30 });
        const loop = yield* goalLoop;
        yield* loop.sweep();
        const childThreadId = (yield* readGoal(threadId)).current!.childThreadId;
        assert.strictEqual((yield* readGoal(threadId)).iterationTimeoutMins, 45);

        yield* TestClock.adjust("41 minutes");
        yield* loop.sweep();
        // This fixture has not opened a provider turn, so steering is rejected.
        // The worker must not mark the nudge delivered merely because it tried.
        assert.isUndefined((yield* readGoal(threadId)).current?.wrapUpSentAt);

        yield* TestClock.adjust("3 minutes");
        yield* loop.sweep();
        assert.isUndefined((yield* readGoal(threadId)).current?.timedOutAt);
        yield* TestClock.adjust("2 minutes");
        yield* loop.sweep();
        assert.isString((yield* readGoal(threadId)).current?.timedOutAt);

        yield* completeChildRun(childThreadId, "interrupted");
        yield* loop.sweep();
        const afterTimeout = yield* readGoal(threadId);
        assert.deepInclude(afterTimeout, { status: "active", current: null });
        assert.strictEqual(afterTimeout.history.at(-1)?.outcome, "timed_out");

        yield* loop.sweep();
        assert.strictEqual((yield* readGoal(threadId)).iteration, 2);
      }),
    ),
  );

  it.effect("pauses when provider usage climbs faster than the burn guard allows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { threadId } = yield* setup("loop-burn");
        const loop = yield* goalLoop;
        const window = (usedPercent: number) => ({
          checkedAt: "2026-10-04T12:00:00.000Z",
          windows: [{ id: "session", kind: "session" as const, label: "5h", usedPercent }],
        });

        usageWindows = window(10);
        yield* loop.sweep();
        yield* loop.sweep();
        // The guard's reading is on the goal for the goal panel to show.
        assert.deepInclude((yield* readGoal(threadId)).usageSample, {
          windows: [{ id: "session", usedPercent: 10 }],
          risePoints: 0,
        });
        usageWindows = window(45);
        yield* loop.sweep();
        const paused = yield* readGoal(threadId);
        assert.deepInclude(paused, { status: "paused", statusReason: "burn_rate" });
        assert.strictEqual(paused.usageSample?.risePoints, 35);
        usageWindows = undefined;
      }),
    ),
  );
});

it.effect(
  "registers the production goal worker after startup activation and retires Stop on scheduler ticks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { orchestrator, threadId, goalId } = yield* setup("scheduler-activation");
        const activation = yield* Deferred.make<void>();
        const sink = yield* EventSink.EventSinkV2;
        const afterSequence = (yield* orchestrator.dispatch({
          type: "thread.goal.control",
          commandId: CommandId.make("scheduler:resume"),
          threadId,
          goalId,
          action: "resume",
        })).sequence;
        const waitForGoal = (iteration: number, retired = false) =>
          sink.stream({ afterSequence }).pipe(
            Stream.filter(
              ({ event }) =>
                event.threadId === threadId &&
                event.type === "thread.metadata-updated" &&
                event.payload.goal?.iteration === iteration &&
                (retired
                  ? event.payload.goal.current === null
                  : event.payload.goal.current !== null),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        yield* Effect.gen(function* () {
          yield* TestClock.adjust("10 seconds");
          assert.strictEqual((yield* readGoal(threadId)).iteration, 0);
          yield* Deferred.succeed(activation, undefined);
          yield* waitForGoal(1);
          const first = yield* readGoal(threadId);
          const childId = first.current!.childThreadId;
          assert.isNull(
            (yield* orchestrator.getThreadRecords(childId, [])).thread.lineage.parentThreadId,
          );
          assert.isEmpty((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs);
          yield* TestClock.adjust("10 seconds");
          assert.strictEqual((yield* readGoal(threadId)).iteration, 1);
          yield* orchestrator.dispatch({
            type: "thread.goal.control",
            commandId: CommandId.make("scheduler:stop"),
            threadId,
            goalId,
            action: "stop",
          });
          yield* TestClock.adjust("10 seconds");
          yield* waitForGoal(1, true);
          assert.strictEqual((yield* readGoal(threadId)).status, "stopped");
          assert.deepEqual(
            (yield* orchestrator.getThreadRecords(childId, ["runs"])).runs.map((run) => run.status),
            ["interrupted"],
          );
          yield* TestClock.adjust("10 seconds");
          assert.strictEqual((yield* readGoal(threadId)).iteration, 1);
        }).pipe(
          Effect.provide(
            GoalLoopWorker.layer.pipe(
              Layer.provide(WorkerDependencies),
              Layer.provide(Scheduler.layer),
            ),
          ),
          Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
        );
      }).pipe(Effect.provide(TestLayer)),
    ),
);
