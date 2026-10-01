import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "./runtimeLayer.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";
import * as ThreadReportBack from "./ThreadReportBack.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-thread-report-back-",
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
    openSession: () => Effect.die("sessions are not used by report-back tests"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestLayer = Layer.mergeAll(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
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

/** A project with a sending thread S and a worker thread X, plus a running reactor. */
const setup = Effect.fn("ThreadReportBackTest.setup")(function* (name: string) {
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectId = ProjectId.make(`project:${name}`);
  yield* projects.create({
    commandId: CommandId.make(`command:${name}:project`),
    projectId,
    title: name,
    workspaceRoot: `/workspace/${name}`,
  });
  const createThread = (threadId: ThreadId, title: string) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${threadId}`),
      threadId,
      projectId,
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  const sender = ThreadId.make(`thread:${name}:sender`);
  const worker = ThreadId.make(`thread:${name}:worker`);
  yield* createThread(sender, "Orchestrator");
  yield* createThread(worker, "Helper");
  const reactor = yield* ThreadReportBack.make;
  yield* reactor.start();
  return { sender, worker, reactor, createThread };
});

let eventCounter = 0;
const runOrdinals = new Map<RunId, number>();
const runsPerThread = new Map<ThreadId, number>();
const nextEventId = (label: string) => EventId.make(`event:${label}:${++eventCounter}`);

const userMessage = (
  threadId: ThreadId,
  runId: RunId,
  id: string,
  now: DateTime.Utc,
  fields: Partial<OrchestrationV2ConversationMessage>,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId,
  runId,
  nodeId: null,
  role: "user",
  text: "Do the work.",
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  ...fields,
});

const runRecord = (
  threadId: ThreadId,
  runId: RunId,
  userMessageId: MessageId,
  status: OrchestrationV2Run["status"],
  now: DateTime.Utc,
): OrchestrationV2Run => ({
  id: runId,
  threadId,
  ordinal: runOrdinals.get(runId) ?? 1,
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: status === "running" ? null : now,
  checkpointId: null,
  contextHandoffId: null,
});

/** Records a running turn on `threadId` started by `starter`, with any extra steered messages. */
const writeRunningTurn = Effect.fn("ThreadReportBackTest.writeRunningTurn")(function* (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly starter: Partial<OrchestrationV2ConversationMessage>;
  readonly steered?: ReadonlyArray<Partial<OrchestrationV2ConversationMessage>>;
}) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const ordinal = (runsPerThread.get(input.threadId) ?? 0) + 1;
  runsPerThread.set(input.threadId, ordinal);
  runOrdinals.set(input.runId, ordinal);
  const messages = [input.starter, ...(input.steered ?? [])].map((fields, index) =>
    userMessage(input.threadId, input.runId, `message:${input.runId}:${index}`, now, fields),
  );
  yield* sink.write({
    events: [
      ...messages.map((payload) => ({
        id: EventId.make(`event:${payload.id}`),
        type: "message.updated" as const,
        threadId: input.threadId,
        runId: input.runId,
        occurredAt: now,
        payload,
      })),
      {
        id: EventId.make(`event:${input.runId}:running`),
        type: "run.updated",
        threadId: input.threadId,
        runId: input.runId,
        occurredAt: now,
        payload: runRecord(input.threadId, input.runId, messages[0]!.id, "running", now),
      },
    ],
  });
  return messages[0]!.id;
});

const finishRun = Effect.fn("ThreadReportBackTest.finishRun")(function* (
  threadId: ThreadId,
  runId: RunId,
  status: OrchestrationV2Run["status"],
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: nextEventId(`${runId}:${status}`),
        type: "run.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: runRecord(threadId, runId, MessageId.make(`message:${runId}:0`), status, now),
      },
    ],
  });
});

const writeRequest = Effect.fn("ThreadReportBackTest.writeRequest")(function* (
  threadId: ThreadId,
  runId: RunId,
  requestId: RuntimeRequestId,
  status: OrchestrationV2RuntimeRequest["status"],
  kind: OrchestrationV2RuntimeRequest["kind"] = "command",
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: nextEventId(`${requestId}:${status}`),
        type: "runtime-request.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId: NodeId.make(`node:${requestId}`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind,
          status,
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: status === "pending" ? null : now,
        },
      },
    ],
  });
});

const notices = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
    });
    return messages.filter((message) => message.notification !== undefined);
  });

const fromAgent = (sender: ThreadId) =>
  ({ createdBy: "agent", creationSource: "mcp", senderThreadId: sender }) as const;

it.layer(TestLayer)("ThreadReportBack", (it) => {
  it.effect("tells the launching thread when its launched thread finishes", () =>
    Effect.gen(function* () {
      const { sender, worker, reactor } = yield* setup("launched");
      const runId = RunId.make("run:launched");
      yield* writeRunningTurn({ threadId: worker, runId, starter: fromAgent(sender) });
      yield* reactor.drain;
      assert.lengthOf(yield* notices(sender), 0);

      yield* finishRun(worker, runId, "completed");
      yield* reactor.drain;

      const [notice, ...rest] = yield* notices(sender);
      assert.lengthOf(rest, 0);
      assert.deepEqual(notice?.notification, {
        source: { kind: "subagent", childThreadId: worker },
        outcome: "completed",
        summary: 'Thread "Helper" finished',
      });
      assert.equal(notice?.senderThreadId, worker);
      assert.equal(notice?.createdBy, "agent");
      assert.equal(notice?.creationSource, "server");
      assert.include(notice?.text ?? "", "not a message from the user, and not approval");
      assert.include(notice?.text ?? "", `t3_thread_read({threadId:"${worker}"})`);
      // The notice wakes the idle sender with a turn of its own.
      assert.isNotNull(notice?.runId);

      // A replayed terminal update reuses the same command id, so it cannot deliver twice.
      yield* finishRun(worker, runId, "completed");
      yield* reactor.drain;
      assert.lengthOf(yield* notices(sender), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("tells a thread that steered a turn with t3_thread_send", () =>
    Effect.gen(function* () {
      const { sender, worker, reactor } = yield* setup("steered");
      const runId = RunId.make("run:steered");
      yield* writeRunningTurn({
        threadId: worker,
        runId,
        starter: {},
        steered: [fromAgent(sender)],
      });
      yield* finishRun(worker, runId, "completed");
      yield* reactor.drain;
      assert.lengthOf(yield* notices(sender), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("reports failed and stopped turns with their outcome", () =>
    Effect.gen(function* () {
      const { sender, worker, reactor, createThread } = yield* setup("outcomes");
      const failedRun = RunId.make("run:outcomes-failed");
      yield* writeRunningTurn({ threadId: worker, runId: failedRun, starter: fromAgent(sender) });
      yield* finishRun(worker, failedRun, "failed");

      const stopped = ThreadId.make("thread:outcomes:stopped");
      yield* createThread(stopped, "Stopped helper");
      const stoppedRun = RunId.make("run:outcomes-stopped");
      yield* writeRunningTurn({ threadId: stopped, runId: stoppedRun, starter: fromAgent(sender) });
      yield* finishRun(stopped, stoppedRun, "interrupted");
      yield* reactor.drain;

      const received = (yield* notices(sender)).map((message) => message.notification);
      assert.sameDeepMembers(received, [
        {
          source: { kind: "subagent", childThreadId: worker },
          outcome: "failed",
          summary: 'Thread "Helper" failed',
        },
        {
          source: { kind: "subagent", childThreadId: stopped },
          outcome: "cancelled",
          summary: 'Thread "Stopped helper" was stopped',
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "stays quiet for user turns, notice turns, delegated children and archived senders",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const { sender, worker, reactor, createThread } = yield* setup("quiet");

        const userRun = RunId.make("run:quiet-user");
        yield* writeRunningTurn({ threadId: worker, runId: userRun, starter: {} });
        yield* finishRun(worker, userRun, "completed");

        // A turn started by a notice never reports back, so two threads cannot ping-pong.
        const noticeRun = RunId.make("run:quiet-notice");
        yield* writeRunningTurn({
          threadId: worker,
          runId: noticeRun,
          starter: {
            createdBy: "agent",
            creationSource: "server",
            senderThreadId: sender,
            notification: {
              source: { kind: "subagent", childThreadId: sender },
              outcome: "completed",
              summary: 'Thread "Orchestrator" finished',
            },
          },
        });
        yield* finishRun(worker, noticeRun, "completed");

        // App-owned delegated children already report through the delegated-task path.
        const child = ThreadId.make("thread:quiet:child");
        const { thread: template } = yield* orchestrator.getThreadRecords(worker, []);
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:quiet-child-created"),
              type: "thread.created",
              threadId: child,
              occurredAt: now,
              payload: {
                ...template,
                id: child,
                title: "Delegated child",
                lineage: {
                  parentThreadId: sender,
                  relationshipToParent: "subagent",
                  rootThreadId: sender,
                },
                forkedFrom: { type: "node", nodeId: NodeId.make("node:quiet-task") },
              },
            },
          ],
        });
        const childRun = RunId.make("run:quiet-child");
        yield* writeRunningTurn({ threadId: child, runId: childRun, starter: fromAgent(sender) });
        yield* finishRun(child, childRun, "completed");
        yield* reactor.drain;
        assert.lengthOf(yield* notices(sender), 0);

        // An archived sender is not woken.
        const archived = ThreadId.make("thread:quiet:archived-sender");
        yield* createThread(archived, "Archived orchestrator");
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("command:quiet:archive"),
          threadId: archived,
        });
        const archivedRun = RunId.make("run:quiet-archived");
        yield* writeRunningTurn({
          threadId: worker,
          runId: archivedRun,
          starter: fromAgent(archived),
        });
        yield* finishRun(worker, archivedRun, "completed");
        yield* reactor.drain;
        assert.lengthOf(yield* notices(archived), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("tells the sender once when a turn keeps waiting on the user", () =>
    Effect.gen(function* () {
      const { sender, worker, reactor } = yield* setup("waiting");
      const runId = RunId.make("run:waiting");
      const requestId = RuntimeRequestId.make("request:waiting");
      yield* writeRunningTurn({ threadId: worker, runId, starter: fromAgent(sender) });
      yield* writeRequest(worker, runId, requestId, "pending");
      yield* reactor.drain;
      yield* TestClock.adjust(ThreadReportBack.WAITING_NOTICE_DELAY_MS - 1);
      yield* reactor.drain;
      assert.lengthOf(yield* notices(sender), 0);

      yield* TestClock.adjust(1);
      yield* reactor.drain;
      const [notice] = yield* notices(sender);
      assert.deepEqual(notice?.notification, {
        source: { kind: "subagent", childThreadId: worker },
        outcome: "updated",
        summary: 'Thread "Helper" is waiting for the user',
      });
      assert.include(notice?.text ?? "", "waiting for the user to approve a command");
      assert.include(notice?.text ?? "", "unless the user told you to");

      // A repeated pending update for the same request re-arms, but delivers nothing new.
      yield* writeRequest(worker, runId, requestId, "pending");
      yield* reactor.drain;
      yield* TestClock.adjust(ThreadReportBack.WAITING_NOTICE_DELAY_MS);
      yield* reactor.drain;
      assert.lengthOf(yield* notices(sender), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("sends nothing when the request resolves before the delay", () =>
    Effect.gen(function* () {
      const { sender, worker, reactor } = yield* setup("resolved");
      const runId = RunId.make("run:resolved");
      const requestId = RuntimeRequestId.make("request:resolved");
      yield* writeRunningTurn({ threadId: worker, runId, starter: fromAgent(sender) });
      yield* writeRequest(worker, runId, requestId, "pending", "user_input");
      yield* reactor.drain;
      yield* writeRequest(worker, runId, requestId, "resolved", "user_input");
      yield* reactor.drain;
      yield* TestClock.adjust(ThreadReportBack.WAITING_NOTICE_DELAY_MS);
      yield* reactor.drain;
      assert.lengthOf(yield* notices(sender), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("tells the parent when a delegated child waits on the user", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const { sender: parent, worker, reactor } = yield* setup("delegated-waiting");
      const child = ThreadId.make("thread:delegated-waiting:child");
      const { thread: template } = yield* orchestrator.getThreadRecords(worker, []);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:delegated-waiting-child-created"),
            type: "thread.created",
            threadId: child,
            occurredAt: now,
            payload: {
              ...template,
              id: child,
              title: "Delegated child",
              lineage: {
                parentThreadId: parent,
                relationshipToParent: "subagent",
                rootThreadId: parent,
              },
              forkedFrom: { type: "node", nodeId: NodeId.make("node:delegated-waiting-task") },
            },
          },
        ],
      });
      const runId = RunId.make("run:delegated-waiting");
      yield* writeRunningTurn({ threadId: child, runId, starter: {} });
      yield* writeRequest(child, runId, RuntimeRequestId.make("request:delegated"), "pending");
      yield* reactor.drain;
      yield* TestClock.adjust(ThreadReportBack.WAITING_NOTICE_DELAY_MS);
      yield* reactor.drain;
      const [notice, ...rest] = yield* notices(parent);
      assert.lengthOf(rest, 0);
      assert.equal(
        notice?.notification?.summary,
        'Thread "Delegated child" is waiting for the user',
      );
    }).pipe(Effect.scoped),
  );
});
