import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  type ServerProvider,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as GoalLoopWorker from "./GoalLoopWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "./runtimeLayer.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-goal-loop-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by goal command tests"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(
  Layer.provideMerge(ProjectServiceLayerLive),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provide(ServerConfigLayer),
      Layer.provide(PlatformTestLayer),
    ),
  ),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(PlatformTestLayer),
);

const setup = Effect.fn("GoalLoopTest.setup")(function* (
  name: string,
  goal: { readonly checkCommand?: string; readonly noProgressLimit?: number } = {},
) {
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectId = ProjectId.make(`project:${name}`);
  yield* projects.create({
    commandId: CommandId.make(`command:${name}:project`),
    projectId,
    title: name,
    workspaceRoot: `/workspace/${name}`,
  });
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
  it.effect("starts an iteration in a fresh top-level thread", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, goalId } = yield* setup("goal-start");
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.deepInclude(shell?.goal, { id: goalId, status: "active", iteration: 0 });

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
      assert.isNull((yield* orchestrator.getThreadShell(threadId))?.goal);
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

/** Marks the current iteration's only child run completed. */
const completeChildRun = Effect.fn("GoalLoopTest.completeChildRun")(function* (
  childThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const run = (yield* orchestrator.getThreadRecords(childThreadId, ["runs"])).runs[0]!;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:${run.id}:completed`),
        type: "run.updated",
        threadId: childThreadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: run.startedAt ?? now, completedAt: now },
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
      commandId: CommandId.make(`command:report:${goal.iteration}:${report.type}`),
      threadId,
      goalId,
      iteration: goal.iteration,
      childThreadId: goal.current!.childThreadId,
      report,
    });
  });

it.layer(TestLayer)("goal loop worker", (it) => {
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
        usageWindows = window(45);
        yield* loop.sweep();
        assert.deepInclude(yield* readGoal(threadId), {
          status: "paused",
          statusReason: "burn_rate",
        });
        usageWindows = undefined;
      }),
    ),
  );
});
