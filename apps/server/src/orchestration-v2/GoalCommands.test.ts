import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
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
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
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
  prefix: "t3-orchestration-v2-goal-commands-",
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

const setup = Effect.fn("GoalCommandsTest.setup")(function* (name: string) {
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
  });
  return { orchestrator, threadId, goalId };
});

it.layer(TestLayer)("goal commands", (it) => {
  it.effect("starts an iteration in an isolated child thread", () =>
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
      assert.strictEqual(child.thread.lineage.parentThreadId, threadId);
      assert.strictEqual(child.thread.lineage.relationshipToParent, "subagent");
      assert.isNull(child.thread.goal);
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
