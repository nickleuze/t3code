import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Tool } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../../../orchestration/ThreadTurnBootstrap.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import * as T3ProjectFileLoader from "../../../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  boundMessages,
  fromThreadMessage,
  threadStatusOf,
  ThreadsToolkitHandlersLive,
} from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const CALLER_ID = ThreadId.make("thread-caller");
const WORKER_ID = ThreadId.make("thread-worker");
const AT = "2026-09-01T00:00:00.000Z";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: AT,
  updatedAt: AT,
};

function makeThread(
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT_ID,
    title: id === CALLER_ID ? "Orchestrator" : "Worker",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const runningSession = (threadId: ThreadId) => ({
  threadId,
  status: "running" as const,
  providerName: "codex",
  runtimeMode: "auto-accept-edits" as const,
  activeTurnId: TurnId.make("turn-1"),
  lastError: null,
  updatedAt: AT,
});

const readySession = (threadId: ThreadId) => ({
  ...runningSession(threadId),
  status: "ready" as const,
  activeTurnId: null,
});

/** The handler only reads these fields of an event. */
const threadEvent = (threadId: ThreadId, type: string) =>
  ({ aggregateKind: "thread", aggregateId: threadId, type }) as unknown as OrchestrationEvent;

interface HarnessOptions {
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly checkoutBranch?: string | null;
  readonly settings?: Partial<typeof DEFAULT_SERVER_SETTINGS>;
}

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const threads = yield* Ref.make(
    new Map(
      (options.threads ?? [makeThread(CALLER_ID), makeThread(WORKER_ID)]).map(
        (thread) => [thread.id, thread] as const,
      ),
    ),
  );
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const bootstraps = yield* Ref.make<ReadonlyArray<ThreadTurnBootstrap.ThreadTurnStartCommand>>([]);
  const closedTerminals = yield* Ref.make<ReadonlyArray<string>>([]);
  const events = yield* Queue.unbounded<OrchestrationEvent>();
  const firstRead = yield* Deferred.make<void>();

  const shellById = (threadId: ThreadId) =>
    Ref.get(threads).pipe(Effect.map((map) => Option.fromNullishOr(map.get(threadId))));

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        shellById(threadId).pipe(
          Effect.map(Option.filter((thread) => thread.archivedAt === null)),
          Effect.tap(() => Deferred.succeed(firstRead, undefined)),
        ),
      getArchivedShellSnapshot: () =>
        Ref.get(threads).pipe(
          Effect.map((map) => ({
            snapshotSequence: 1,
            projects: [project],
            threads: [...map.values()].filter((thread) => thread.archivedAt !== null),
            updatedAt: AT,
          })),
        ),
      getShellSnapshot: () =>
        Ref.get(threads).pipe(
          Effect.map((map) => ({
            snapshotSequence: 1,
            projects: [project],
            threads: [...map.values()].filter((thread) => thread.archivedAt === null),
            updatedAt: AT,
          })),
        ),
      getProjectShellById: (projectId) =>
        Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      getThreadDetailSnapshot: (threadId) =>
        Effect.succeed(
          Option.some({
            snapshotSequence: 1,
            thread: {
              ...makeThread(threadId),
              deletedAt: null,
              proposedPlans: [],
              activities: [],
              checkpoints: [],
              messages: [
                {
                  id: MessageId.make("m-1"),
                  role: "user" as const,
                  text: "Do the thing",
                  turnId: null,
                  streaming: false,
                  createdAt: AT,
                  updatedAt: AT,
                },
                {
                  id: MessageId.make("m-2"),
                  role: "assistant" as const,
                  text: "Done: the thing",
                  turnId: TurnId.make("turn-1"),
                  streaming: false,
                  createdAt: AT,
                  updatedAt: AT,
                },
              ],
            },
          }),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 })),
      subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
    }),
    Layer.mock(ProjectionTurnRepository)({
      getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
    }),
    Layer.succeed(ThreadTurnBootstrap.ThreadTurnBootstrap, {
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(bootstraps, (recorded) => [...recorded, command]);
          const create = command.bootstrap?.createThread;
          if (create) {
            yield* Ref.update(threads, (map) =>
              new Map(map).set(
                command.threadId,
                makeThread(command.threadId, {
                  projectId: create.projectId,
                  title: create.title,
                  modelSelection: create.modelSelection,
                  runtimeMode: create.runtimeMode,
                  branch: create.branch,
                }),
              ),
            );
          }
          return { sequence: 1 };
        }),
    }),
    ServerSettings.ServerSettingsService.layerTest(options.settings ?? {}),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      localStatus: () =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: true,
          isDefaultRef: true,
          refName: options.checkoutBranch === undefined ? "main" : options.checkoutBranch,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        }),
    }),
    Layer.succeed(T3ProjectFileLoader.T3ProjectFileLoader, {
      load: () => Effect.succeed(Option.none()),
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      close: (input) => Ref.update(closedTerminals, (closed) => [...closed, input.threadId]),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof ThreadsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["threads"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ThreadsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: CALLER_ID,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
    );
  const setThread = (thread: OrchestrationThreadShell) =>
    Ref.update(threads, (map) => new Map(map).set(thread.id, thread));
  return { call, commands, bootstraps, closedTerminals, events, firstRead, setThread };
});

describe("threadStatusOf", () => {
  it("reads a queued message on a finished thread as starting", () => {
    const thread = makeThread(WORKER_ID, { session: readySession(WORKER_ID) });
    expect(threadStatusOf(thread, false)).toBe("completed");
    expect(threadStatusOf(thread, true)).toBe("starting");
  });

  it("puts a pending approval ahead of running", () => {
    const thread = makeThread(WORKER_ID, {
      session: runningSession(WORKER_ID),
      hasPendingApprovals: true,
    });
    expect(threadStatusOf(thread, true)).toBe("waiting_for_approval");
  });
});

describe("boundMessages", () => {
  it("keeps the newest user and assistant messages that fit", () => {
    const result = boundMessages(
      [
        { role: "user", text: "a".repeat(30), createdAt: AT },
        { role: "reasoning", text: "thinking", createdAt: AT },
        { role: "assistant", text: "b".repeat(30), createdAt: AT },
        { role: "user", text: "c".repeat(30), createdAt: AT },
      ],
      20,
      45,
    );
    expect(result.dropped).toBe(1);
    expect(
      result.messages.map((message) => [message.role, message.text, message.truncated]),
    ).toEqual([
      ["assistant", `${"b".repeat(20)}…`, true],
      ["user", `${"c".repeat(20)}…`, true],
    ]);
  });
});

describe("threads toolkit handlers", () => {
  it.effect("refuses a credential without the threads capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("list_threads", {}, ["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "threads" });
    }),
  );

  it.effect("lists threads and marks the caller", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("list_threads", {});
      expect(
        result.threads.map((thread) => [thread.threadId, thread.isCurrentThread, thread.status]),
      ).toEqual(
        expect.arrayContaining([
          [CALLER_ID, true, "idle"],
          [WORKER_ID, false, "idle"],
        ]),
      );
    }),
  );

  it.effect("sends a message tagged with the sender, in the target's own modes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [
          makeThread(CALLER_ID),
          makeThread(WORKER_ID, { runtimeMode: "approval-required", interactionMode: "plan" }),
        ],
      });
      yield* harness.call("send_thread_message", { threadId: WORKER_ID, message: "Status?" });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.turn.start",
          threadId: WORKER_ID,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          message: {
            role: "user",
            text: fromThreadMessage({ id: CALLER_ID, title: "Orchestrator" }, "Status?"),
          },
        },
      ]);
    }),
  );

  it.effect("refuses to drive a thread with more access than the caller", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [makeThread(CALLER_ID), makeThread(WORKER_ID, { runtimeMode: "full-access" })],
      });
      const error = yield* harness
        .call("send_thread_message", { threadId: WORKER_ID, message: "rm -rf" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ThreadRuntimeModeNotAllowedError",
        requested: "full-access",
        allowed: "auto-accept-edits",
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("refuses to message or wait on its own thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const send = yield* harness
        .call("send_thread_message", { threadId: CALLER_ID, message: "hi" })
        .pipe(Effect.flip);
      const wait = yield* harness
        .call("wait_for_threads", { threadIds: [CALLER_ID] })
        .pipe(Effect.flip);
      expect([send._tag, wait._tag]).toEqual([
        "ThreadIsCurrentThreadError",
        "ThreadIsCurrentThreadError",
      ]);
    }),
  );

  it.effect("creates a worktree thread from the checkout branch by default", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ settings: { defaultThreadEnvMode: "worktree" } });
      const result = yield* harness.call("create_thread", { message: "Fix the flaky test" });
      expect(result.preparing).toBe(false);
      expect(result.thread).toMatchObject({
        title: "Fix the flaky test",
        runtimeMode: "auto-accept-edits",
      });
      const [command] = yield* Ref.get(harness.bootstraps);
      expect(command).toMatchObject({
        titleSeed: "Fix the flaky test",
        runtimeMode: "auto-accept-edits",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        bootstrap: {
          createThread: { projectId: PROJECT_ID, title: "Fix the flaky test", branch: "main" },
          prepareWorktree: { projectCwd: "/workspace/project", baseBranch: "main" },
          runSetupScript: true,
        },
      });
      expect(command?.bootstrap?.prepareWorktree?.requireWorktree).toBeUndefined();
      expect(command?.message.text).toContain('thread "Orchestrator"');
    }),
  );

  it.effect("creates a local thread without preparing a worktree", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ settings: { defaultThreadEnvMode: "worktree" } });
      yield* harness.call("create_thread", {
        message: "Look around",
        workspace: "local",
        title: "Explore",
        provider: "claudeAgent",
        model: "claude-opus-5-5",
      });
      const [command] = yield* Ref.get(harness.bootstraps);
      expect(command?.titleSeed).toBeUndefined();
      expect(command?.bootstrap?.prepareWorktree).toBeUndefined();
      expect(command?.bootstrap?.runSetupScript).toBe(false);
      expect(command?.modelSelection).toEqual({
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
      });
    }),
  );

  it.effect("requires a base branch for an explicit worktree", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ checkoutBranch: null });
      const error = yield* harness
        .call("create_thread", { message: "Go", workspace: "worktree" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("WorktreeBaseBranchRequiredError");
      expect(yield* Ref.get(harness.bootstraps)).toEqual([]);
    }),
  );

  it.effect("refuses to create a thread with more access than the caller", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("create_thread", { message: "Go", runtimeMode: "full-access" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ThreadRuntimeModeNotAllowedError");
    }),
  );

  it.effect("returns at once for a finished thread, with its last reply", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [
          makeThread(CALLER_ID),
          makeThread(WORKER_ID, { session: readySession(WORKER_ID) }),
        ],
      });
      const result = yield* harness.call("wait_for_threads", { threadIds: [WORKER_ID] });
      expect(result.timedOut).toBe(false);
      expect(result.threads).toMatchObject([
        {
          finished: true,
          lastAssistantMessage: "Done: the thing",
          thread: { status: "completed" },
        },
      ]);
    }),
  );

  it.effect("waits for the thread's turn to end", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [
          makeThread(CALLER_ID),
          makeThread(WORKER_ID, { session: runningSession(WORKER_ID) }),
        ],
      });
      const waiting = yield* harness
        .call("wait_for_threads", { threadIds: [WORKER_ID] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(harness.firstRead);
      yield* harness.setThread(makeThread(WORKER_ID, { session: readySession(WORKER_ID) }));
      yield* Queue.offer(harness.events, threadEvent(WORKER_ID, "thread.session-set"));
      const result = yield* Fiber.join(waiting);
      expect(result.timedOut).toBe(false);
      expect(result.threads[0]).toMatchObject({ finished: true, thread: { status: "completed" } });
    }),
  );

  it.effect("reports a timeout while the thread is still running", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [
          makeThread(CALLER_ID),
          makeThread(WORKER_ID, { session: runningSession(WORKER_ID) }),
        ],
      });
      const waiting = yield* harness
        .call("wait_for_threads", { threadIds: [WORKER_ID], timeoutSeconds: 5 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(harness.firstRead);
      // Step the clock so the timeout is scheduled before time passes it.
      for (let second = 0; second < 10 && waiting.pollUnsafe() === undefined; second++) {
        yield* TestClock.adjust(Duration.seconds(1));
      }
      const result = yield* Fiber.join(waiting);
      expect(result.timedOut).toBe(true);
      expect(result.threads[0]).toMatchObject({
        finished: false,
        lastAssistantMessage: null,
        thread: { status: "running" },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("interrupts only a running thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [
          makeThread(CALLER_ID),
          makeThread(WORKER_ID, { session: runningSession(WORKER_ID) }),
        ],
      });
      const result = yield* harness.call("interrupt_thread", { threadId: WORKER_ID });
      expect(result.wasRunning).toBe(true);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.turn.interrupt", threadId: WORKER_ID, turnId: "turn-1" },
      ]);
    }),
  );

  it.effect("archives a thread, stopping its agent and closing its terminals", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [
          makeThread(CALLER_ID),
          makeThread(WORKER_ID, { session: readySession(WORKER_ID) }),
        ],
      });
      yield* harness.call("update_thread", { threadId: WORKER_ID, archived: true });
      expect((yield* Ref.get(harness.commands)).map((command) => command.type)).toEqual([
        "thread.archive",
        "thread.session.stop",
      ]);
      expect(yield* Ref.get(harness.closedTerminals)).toEqual([WORKER_ID]);
    }),
  );

  it.effect("refuses to archive its own thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("update_thread", { threadId: CALLER_ID, archived: true })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ThreadIsCurrentThreadError");
    }),
  );

  it.effect("unarchives before renaming an archived thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [makeThread(CALLER_ID), makeThread(WORKER_ID, { archivedAt: AT })],
      });
      yield* harness.call("update_thread", { threadId: WORKER_ID, archived: false, title: "Back" });
      expect((yield* Ref.get(harness.commands)).map((command) => command.type)).toEqual([
        "thread.unarchive",
        "thread.meta.update",
      ]);
    }),
  );
});
