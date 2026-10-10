import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
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
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { layerEventSink, layer, layerProjectService } from "./runtimeLayer.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
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
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const makeTestLayer = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Layer.mergeAll(layer, layerEventSink, EventStore.layer).pipe(
    Layer.provideMerge(layerProjectService),
    Layer.provide(
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(ProviderTurnStartServiceTestkit.layer),
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
    Layer.provideMerge(database),
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
    Layer.provide(McpProviderSessions.layer),
  );

/** A project with a sending thread S and worker threads, without a running reactor. */
const setupThreads = Effect.fn("ThreadReportBackTest.setupThreads")(function* (
  name: string,
  workers: ReadonlyArray<string> = ["Helper"],
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
  yield* createThread(sender, "Orchestrator");
  const workerIds: Array<ThreadId> = [];
  for (const [index, title] of workers.entries()) {
    const worker = ThreadId.make(`thread:${name}:worker-${index}`);
    yield* createThread(worker, title);
    workerIds.push(worker);
  }
  return { sender, workers: workerIds, createThread };
});

/** A sending thread S and a worker thread X, plus a running reactor. */
const setup = Effect.fn("ThreadReportBackTest.setup")(function* (name: string) {
  const threads = yield* setupThreads(name);
  const reactor = yield* ThreadReportBack.make;
  yield* reactor.start();
  return { ...threads, worker: threads.workers[0]!, reactor };
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
  commandId?: CommandId,
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    ...(commandId === undefined ? {} : { commandId }),
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

const notices = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
    });
    return messages.filter((message) => message.notification !== undefined);
  });

/**
 * Runs `trigger` and waits for the notice from `source` it causes `recipient`
 * to receive. The reactor handles runs in commit order, so runs that ended
 * before the trigger's run have been decided by then.
 */
const awaitNoticeAfter = <A, E, R>(
  recipient: ThreadId,
  source: ThreadId,
  trigger: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence();
    yield* trigger;
    const notice = yield* sink.stream({ afterSequence, eventType: "message.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "message.updated" &&
          stored.event.threadId === recipient &&
          stored.event.payload.notification !== undefined &&
          stored.event.payload.senderThreadId === source,
      ),
      Stream.runHead,
    );
    assert.isTrue(notice._tag === "Some");
  });

const fromAgent = (sender: ThreadId) =>
  ({ createdBy: "agent", creationSource: "mcp", senderThreadId: sender }) as const;

it.layer(makeTestLayer(SqlitePersistence.layerMemory))("ThreadReportBack", (it) => {
  it.effect("tells the launching thread when its launched thread finishes", () =>
    Effect.gen(function* () {
      const { sender, worker, createThread } = yield* setup("launched");
      const runId = RunId.make("run:launched");
      yield* writeRunningTurn({ threadId: worker, runId, starter: fromAgent(sender) });
      yield* awaitNoticeAfter(sender, worker, finishRun(worker, runId, "completed"));

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
      const later = ThreadId.make("thread:launched:later");
      yield* createThread(later, "Later helper");
      const laterRun = RunId.make("run:launched-later");
      yield* writeRunningTurn({ threadId: later, runId: laterRun, starter: fromAgent(sender) });
      yield* awaitNoticeAfter(sender, later, finishRun(later, laterRun, "completed"));
      assert.lengthOf(yield* notices(sender), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("tells a thread that steered a turn with t3_thread_send", () =>
    Effect.gen(function* () {
      const { sender, worker } = yield* setup("steered");
      const runId = RunId.make("run:steered");
      yield* writeRunningTurn({
        threadId: worker,
        runId,
        starter: {},
        steered: [fromAgent(sender)],
      });
      yield* awaitNoticeAfter(sender, worker, finishRun(worker, runId, "completed"));
      assert.lengthOf(yield* notices(sender), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("reports failed and stopped turns with their outcome", () =>
    Effect.gen(function* () {
      const { sender, worker, createThread } = yield* setup("outcomes");
      const failedRun = RunId.make("run:outcomes-failed");
      yield* writeRunningTurn({ threadId: worker, runId: failedRun, starter: fromAgent(sender) });
      yield* finishRun(worker, failedRun, "failed");

      const stopped = ThreadId.make("thread:outcomes:stopped");
      yield* createThread(stopped, "Stopped helper");
      const stoppedRun = RunId.make("run:outcomes-stopped");
      yield* writeRunningTurn({ threadId: stopped, runId: stoppedRun, starter: fromAgent(sender) });
      yield* awaitNoticeAfter(sender, stopped, finishRun(stopped, stoppedRun, "interrupted"));

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
    "stays quiet for user turns, notice turns, delegated children, archived senders and restart reconciliation",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const { sender, worker, createThread } = yield* setup("quiet");

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

        // Live reconciliation is left to the startup sweep.
        const reconciledRun = RunId.make("run:quiet-reconciled");
        yield* writeRunningTurn({
          threadId: worker,
          runId: reconciledRun,
          starter: fromAgent(sender),
        });
        yield* finishRun(
          worker,
          reconciledRun,
          "cancelled",
          CommandId.make("command:runtime-reconcile:shutdown:quiet"),
        );

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
          steered: [fromAgent(sender)],
        });

        // The last run reports, so every earlier one has been decided.
        yield* awaitNoticeAfter(sender, worker, finishRun(worker, archivedRun, "completed"));
        const received = yield* notices(sender);
        assert.deepEqual(
          received.map((message) => message.id),
          [MessageId.make(`thread-report-back:finished:${worker}:${archivedRun}:${sender}`)],
        );
        assert.lengthOf(yield* notices(archived), 0);
      }).pipe(Effect.scoped),
  );
});

it.effect("delivers reports a restart left pending, once, after reopening the database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-report-back-" });
    // Each runtime opens and closes its own connection to the same file.
    const runtime = () =>
      makeTestLayer(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")));
    const delivered = RunId.make("run:restart-delivered");
    const unreported = RunId.make("run:restart-unreported");
    const reconciled = RunId.make("run:restart-reconciled");

    const { sender, workers } = yield* Effect.gen(function* () {
      const threads = yield* setupThreads("restart", ["Delivered", "Unreported", "Reconciled"]);
      const [deliveredThread, unreportedThread, reconciledThread] = threads.workers;
      yield* writeRunningTurn({
        threadId: deliveredThread!,
        runId: delivered,
        starter: fromAgent(threads.sender),
      });
      yield* writeRunningTurn({
        threadId: unreportedThread!,
        runId: unreported,
        starter: fromAgent(threads.sender),
      });
      yield* writeRunningTurn({
        threadId: reconciledThread!,
        runId: reconciled,
        starter: fromAgent(threads.sender),
      });
      // Reported live before the restart.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* ThreadReportBack.make;
          yield* reactor.start();
          yield* awaitNoticeAfter(
            threads.sender,
            deliveredThread!,
            finishRun(deliveredThread!, delivered, "completed"),
          );
        }),
      );
      // Ends after the reactor stopped, as when the server goes down before delivering.
      yield* finishRun(unreportedThread!, unreported, "completed");
      assert.lengthOf(yield* notices(threads.sender), 1);
      return threads;
    }).pipe(Effect.provide(runtime()));

    const afterRestart = Effect.gen(function* () {
      const reactor = yield* ThreadReportBack.make;
      yield* reactor.start();
      // Startup reconciliation stops the turn that was still running.
      yield* finishRun(
        workers[2]!,
        reconciled,
        "cancelled",
        CommandId.make("command:runtime-reconcile:startup:restart"),
      );
      yield* reactor.sweep;
      yield* reactor.drain;
      return (yield* notices(sender)).map((message) => message.id);
    }).pipe(Effect.scoped);

    const expected = [
      [workers[0]!, delivered],
      [workers[1]!, unreported],
      [workers[2]!, reconciled],
    ].map(([thread, run]) =>
      MessageId.make(`thread-report-back:finished:${thread}:${run}:${sender}`),
    );
    assert.sameMembers(yield* afterRestart.pipe(Effect.provide(runtime())), expected);
    // A second restart finds nothing new to deliver.
    assert.sameMembers(yield* afterRestart.pipe(Effect.provide(runtime())), expected);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
