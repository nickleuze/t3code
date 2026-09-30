import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { resolveThreadAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { truncate } from "@t3tools/shared/String";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../../../orchestration/ThreadTurnBootstrap.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import * as T3ProjectFileLoader from "../../../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DEFAULT_LIST_THREADS,
  DEFAULT_READ_TURNS,
  DEFAULT_WAIT_SECONDS,
  ProjectNotFoundError,
  ThreadIsCurrentThreadError,
  type ThreadMessageEntry,
  ThreadNotFoundError,
  ThreadRuntimeModeNotAllowedError,
  type ThreadStatus,
  type ThreadSummary,
  ThreadToolFailedError,
  ThreadsToolkit,
  type WaitedThread,
  WorktreeBaseBranchRequiredError,
} from "./tools.ts";

/** Per message, so one long answer cannot crowd out the rest of the turn. */
export const MAX_MESSAGE_CHARS = 8_000;
/** Across a read_thread result; older messages give way first. */
export const MAX_READ_CHARS = 40_000;
/**
 * How long create_thread waits for the agent to start before reporting the
 * thread as preparing. A new worktree's checkout and setup script can take
 * minutes, and some providers give up on a tool call after a minute.
 */
const CREATE_THREAD_WAIT = Duration.seconds(20);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const cut = (text: string, max: number) =>
  text.length > max
    ? { text: `${text.slice(0, max)}…`, truncated: true }
    : { text, truncated: false };

/** Runtime modes in increasing order of what an agent may do unasked. */
const runtimeModeRank = (mode: RuntimeMode) => RuntimeMode.literals.indexOf(mode);

const ACTIVE_STATUSES: ReadonlySet<ThreadStatus> = new Set(["starting", "running"]);

/**
 * The sidebar's phase for a thread, plus a queued message no turn has picked
 * up yet, which would otherwise read as finished until the agent starts.
 */
export function threadStatusOf(
  thread: OrchestrationThreadShell,
  hasPendingTurnStart: boolean,
): ThreadStatus {
  const phase = resolveThreadAwarenessPhase(thread);
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return phase;
  if (phase === "starting" || phase === "running") return phase;
  if (hasPendingTurnStart) return "starting";
  if (phase === "failed" || phase === "completed") return phase;
  return "idle";
}

/** Marks agent-sent messages so the receiving agent and the user can see who sent them. */
export function fromThreadMessage(
  sender: Pick<OrchestrationThreadShell, "id" | "title">,
  text: string,
): string {
  return `[Message from the agent in thread "${sender.title}" (${sender.id}). It reads your reply in this thread.]\n\n${text}`;
}

/** Keeps the newest messages that fit in `maxChars`, cutting each to `perMessage` first. */
export function boundMessages(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly createdAt: string;
  }>,
  perMessage = MAX_MESSAGE_CHARS,
  maxChars = MAX_READ_CHARS,
): { readonly messages: ReadonlyArray<ThreadMessageEntry>; readonly dropped: number } {
  const entries: Array<ThreadMessageEntry> = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const { text, truncated } = cut(message.text, perMessage);
    entries.push({ role: message.role, text, truncated, createdAt: message.createdAt });
  }
  let total = 0;
  let firstKept = entries.length;
  while (firstKept > 0 && total + entries[firstKept - 1]!.text.length <= maxChars) {
    firstKept -= 1;
    total += entries[firstKept]!.text.length;
  }
  return { messages: entries.slice(firstKept), dropped: firstKept };
}

/**
 * The requested model, else `base`. A provider without a model reuses the
 * model of whichever default already runs on that provider. Provider options
 * such as effort only carry over while the model is unchanged.
 */
export const chooseModel = (
  base: ModelSelection,
  caller: ModelSelection,
  input: { readonly provider?: string | undefined; readonly model?: string | undefined },
): Effect.Effect<ModelSelection, ThreadToolFailedError> => {
  if (input.provider === undefined && input.model === undefined) return Effect.succeed(base);
  const instanceId = ProviderInstanceId.make(input.provider ?? base.instanceId);
  const sameProvider = [base, caller].find((selection) => selection.instanceId === instanceId);
  const model = input.model ?? sameProvider?.model;
  if (model === undefined) {
    return Effect.fail(
      new ThreadToolFailedError({
        operation: "choose a model",
        detail: `pass model together with provider ${instanceId}.`,
        cause: null,
      }),
    );
  }
  return Effect.succeed(
    sameProvider !== undefined && sameProvider.model === model
      ? sameProvider
      : { instanceId, model },
  );
};

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurnRepository;
  const bootstrap = yield* ThreadTurnBootstrap.ThreadTurnBootstrap;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const terminals = yield* TerminalManager.TerminalManager;
  const crypto = yield* Crypto.Crypto;

  const failed =
    (operation: string) =>
    <E>(cause: E) =>
      new ThreadToolFailedError({
        operation,
        ...(cause instanceof Error && cause.message.length > 0 ? { detail: cause.message } : {}),
        cause,
      });

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`server:mcp-${tag}:${id}`)));

  const dispatch = (
    operation: string,
    command: Parameters<OrchestrationEngine.OrchestrationEngineShape["dispatch"]>[0],
  ) => engine.dispatch(command).pipe(Effect.mapError(failed(operation)));

  const requireScope = McpInvocationContext.requireMcpCapability("threads");

  const findThread = Effect.fn("ThreadsToolkit.findThread")(function* (
    threadId: string,
    options: { readonly includeArchived?: boolean } = {},
  ) {
    const active = yield* snapshots
      .getThreadShellById(ThreadId.make(threadId))
      .pipe(Effect.mapError(failed("read the thread")));
    if (Option.isSome(active)) return active.value;
    if (options.includeArchived === true) {
      const archived = yield* snapshots
        .getArchivedShellSnapshot()
        .pipe(Effect.mapError(failed("read archived threads")));
      const match = archived.threads.find((thread) => thread.id === threadId);
      if (match !== undefined) return match;
    }
    return yield* new ThreadNotFoundError({ threadId });
  });

  const findProject = Effect.fn("ThreadsToolkit.findProject")(function* (projectId: string) {
    const project = yield* snapshots
      .getProjectShellById(ProjectId.make(projectId))
      .pipe(Effect.mapError(failed("read the project")));
    if (Option.isNone(project)) return yield* new ProjectNotFoundError({ projectId });
    return project.value;
  });

  const statusOf = (thread: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const phase = threadStatusOf(thread, false);
      // Only a thread that looks finished can hide a queued message.
      if (phase !== "completed" && phase !== "failed" && phase !== "idle") return phase;
      const pending = yield* turns
        .getPendingTurnStartByThreadId({ threadId: thread.id })
        .pipe(Effect.mapError(failed("read the thread's queued messages")));
      return threadStatusOf(thread, Option.isSome(pending));
    });

  const summarize = (thread: OrchestrationThreadShell, currentThreadId: ThreadId) =>
    statusOf(thread).pipe(
      Effect.map((status): ThreadSummary => ({
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        status,
        lastError: thread.session?.lastError ?? null,
        provider: thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        archived: thread.archivedAt !== null,
        isCurrentThread: thread.id === currentThreadId,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      })),
    );

  const refreshed = (threadId: ThreadId, currentThreadId: ThreadId) =>
    findThread(threadId, { includeArchived: true }).pipe(
      Effect.flatMap((thread) => summarize(thread, currentThreadId)),
    );

  const assertMayRun = (requested: RuntimeMode, caller: OrchestrationThreadShell) =>
    runtimeModeRank(requested) > runtimeModeRank(caller.runtimeMode)
      ? Effect.fail(
          new ThreadRuntimeModeNotAllowedError({ requested, allowed: caller.runtimeMode }),
        )
      : Effect.void;

  const lastAssistantMessage = (threadId: ThreadId) =>
    snapshots.getThreadDetailSnapshot(threadId, { turnLimit: 1 }).pipe(
      Effect.mapError(failed("read the thread")),
      Effect.map((detail) => {
        const message = Option.getOrUndefined(detail)?.thread.messages.findLast(
          (entry) => entry.role === "assistant",
        );
        return message === undefined ? null : cut(message.text, MAX_MESSAGE_CHARS);
      }),
    );

  /** Settings resolved for a project the way the new-thread composer resolves them. */
  const projectSettings = Effect.fn("ThreadsToolkit.projectSettings")(function* (
    project: OrchestrationProjectShell,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failed("read settings")),
    );
    const projectFile = yield* projectFiles.load(project.workspaceRoot);
    return resolveProjectSettings(settings, project.id, project, Option.getOrNull(projectFile))
      .settings;
  });

  return ThreadsToolkit.of({
    list_projects: () =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        const caller = yield* findThread(scope.threadId);
        const shell = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.mapError(failed("list projects")));
        return {
          projects: shell.projects.map((project) => ({
            projectId: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            isCurrentProject: project.id === caller.projectId,
          })),
        };
      }),

    list_threads: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        const shell = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.mapError(failed("list threads")));
        const archived =
          input.includeArchived === true
            ? (yield* snapshots
                .getArchivedShellSnapshot()
                .pipe(Effect.mapError(failed("list archived threads")))).threads
            : [];
        const matching = [...shell.threads, ...archived]
          .filter((thread) => input.projectId === undefined || thread.projectId === input.projectId)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const limit = input.limit ?? DEFAULT_LIST_THREADS;
        const threads = yield* Effect.forEach(matching.slice(0, limit), (thread) =>
          summarize(thread, scope.threadId),
        );
        return { threads, truncated: matching.length > limit };
      }),

    read_thread: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        const thread = yield* findThread(input.threadId);
        const detail = yield* snapshots
          .getThreadDetailSnapshot(thread.id, { turnLimit: input.turns ?? DEFAULT_READ_TURNS })
          .pipe(Effect.mapError(failed("read the thread")));
        if (Option.isNone(detail)) return yield* new ThreadNotFoundError({ threadId: thread.id });
        const bounded = boundMessages(detail.value.thread.messages);
        return {
          thread: yield* summarize(thread, scope.threadId),
          messages: bounded.messages,
          hasOlderMessages: bounded.dropped > 0 || detail.value.page?.hasMore === true,
        };
      }),

    create_thread: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        const caller = yield* findThread(scope.threadId);
        const project = yield* findProject(input.projectId ?? caller.projectId);
        const settings = yield* projectSettings(project);

        const runtimeMode = input.runtimeMode ?? caller.runtimeMode;
        yield* assertMayRun(runtimeMode, caller);

        const modelSelection = yield* chooseModel(
          settings.defaultModelSelection ?? caller.modelSelection,
          caller.modelSelection,
          input,
        );

        const workspace: ThreadEnvMode = input.workspace ?? settings.defaultThreadEnvMode;
        const checkoutBranch = yield* gitWorkflow.localStatus({ cwd: project.workspaceRoot }).pipe(
          Effect.map((status) => status.refName),
          Effect.orElseSucceed(() => null),
        );
        const baseBranch = input.baseBranch ?? checkoutBranch;
        // An explicit worktree must be one; the project default falls back to
        // the checkout like the composer does when git cannot make one.
        if (workspace === "worktree" && baseBranch === null && input.workspace === "worktree") {
          return yield* new WorktreeBaseBranchRequiredError({ projectId: project.id });
        }
        const branchToken = yield* crypto.randomBytes(4).pipe(
          Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
          Effect.orDie,
        );
        const prepareWorktree =
          workspace === "worktree" && baseBranch !== null
            ? {
                projectCwd: project.workspaceRoot,
                baseBranch,
                branch: buildTemporaryWorktreeBranchName(() => branchToken),
                ...(settings.newWorktreesStartFromOrigin ? { startFromOrigin: true } : {}),
                ...(input.workspace === "worktree" ? { requireWorktree: true } : {}),
              }
            : undefined;

        const threadId = ThreadId.make(yield* uuid);
        const createdAt = yield* nowIso;
        const title = input.title ?? truncate(input.message);
        const interactionMode = input.interactionMode ?? "default";
        const started = yield* bootstrap
          .dispatch({
            type: "thread.turn.start",
            commandId: yield* commandId("thread-create"),
            threadId,
            message: {
              messageId: MessageId.make(yield* uuid),
              role: "user",
              text: fromThreadMessage(caller, input.message),
              attachments: [],
            },
            modelSelection,
            ...(input.title === undefined ? { titleSeed: title } : {}),
            runtimeMode,
            interactionMode,
            bootstrap: {
              createThread: {
                projectId: project.id,
                title,
                modelSelection,
                runtimeMode,
                interactionMode,
                branch: prepareWorktree === undefined ? checkoutBranch : baseBranch,
                worktreePath: null,
                createdAt,
              },
              ...(prepareWorktree === undefined ? {} : { prepareWorktree }),
              runSetupScript: prepareWorktree !== undefined,
            },
            createdAt,
          })
          .pipe(Effect.exit, Effect.forkDetach);
        // The bootstrap outlives this call: a slow checkout or setup script
        // keeps going, and the new thread reports it as starting meanwhile.
        const outcome = yield* Fiber.join(started).pipe(Effect.timeoutOption(CREATE_THREAD_WAIT));
        if (Option.isSome(outcome) && Exit.isFailure(outcome.value)) {
          const error = Cause.squash(outcome.value.cause);
          return yield* failed("create the thread")(error);
        }
        return {
          thread: yield* refreshed(threadId, scope.threadId),
          preparing: Option.isNone(outcome),
        };
      }),

    send_thread_message: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        if (input.threadId === scope.threadId) {
          return yield* new ThreadIsCurrentThreadError({ operation: "message" });
        }
        const caller = yield* findThread(scope.threadId);
        const target = yield* findThread(input.threadId);
        yield* assertMayRun(target.runtimeMode, caller);
        yield* dispatch("send the message", {
          type: "thread.turn.start",
          commandId: yield* commandId("thread-message"),
          threadId: target.id,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text: fromThreadMessage(caller, input.message),
            attachments: [],
          },
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
          createdAt: yield* nowIso,
        });
        return { thread: yield* refreshed(target.id, scope.threadId) };
      }),

    wait_for_threads: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        const threadIds = Array.from(new Set(input.threadIds), (id) => ThreadId.make(id));
        if (threadIds.includes(scope.threadId)) {
          return yield* new ThreadIsCurrentThreadError({ operation: "wait for" });
        }
        const until = input.until ?? "all";
        const check = Effect.forEach(threadIds, (threadId) =>
          findThread(threadId, { includeArchived: true }).pipe(
            Effect.flatMap((thread) => summarize(thread, scope.threadId)),
            Effect.map((thread) => ({ thread, finished: !ACTIVE_STATUSES.has(thread.status) })),
          ),
        );
        const isDone = (states: ReadonlyArray<{ readonly finished: boolean }>) =>
          until === "all"
            ? states.every((state) => state.finished)
            : states.some((state) => state.finished);

        const { states, timedOut } = yield* Effect.scoped(
          Effect.gen(function* () {
            // Subscribe before the first read so a turn ending in between is not missed.
            const events = yield* engine.subscribeDomainEvents;
            const initial = yield* check;
            if (isDone(initial)) return { states: initial, timedOut: false };
            const watched = new Set<string>(threadIds);
            const reached = yield* events.pipe(
              // Streamed message text never changes whether a thread is working.
              Stream.filter(
                (event: OrchestrationEvent) =>
                  event.aggregateKind === "thread" &&
                  watched.has(event.aggregateId) &&
                  event.type !== "thread.message-sent",
              ),
              Stream.mapEffect(() => check),
              Stream.filter(isDone),
              Stream.runHead,
              Effect.timeoutOption(Duration.seconds(input.timeoutSeconds ?? DEFAULT_WAIT_SECONDS)),
              Effect.map(Option.flatten),
            );
            return Option.isSome(reached)
              ? { states: reached.value, timedOut: false }
              : { states: yield* check, timedOut: true };
          }),
        );

        const threads = yield* Effect.forEach(
          states,
          ({ thread, finished }): Effect.Effect<WaitedThread, ThreadToolFailedError> =>
            finished
              ? lastAssistantMessage(ThreadId.make(thread.threadId)).pipe(
                  Effect.map((message) => ({
                    thread,
                    finished,
                    lastAssistantMessage: message?.text ?? null,
                    lastAssistantMessageTruncated: message?.truncated ?? false,
                  })),
                )
              : Effect.succeed({
                  thread,
                  finished,
                  lastAssistantMessage: null,
                  lastAssistantMessageTruncated: false,
                }),
        );
        return { threads, timedOut };
      }),

    interrupt_thread: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        if (input.threadId === scope.threadId) {
          return yield* new ThreadIsCurrentThreadError({ operation: "interrupt" });
        }
        const thread = yield* findThread(input.threadId);
        const wasRunning = ACTIVE_STATUSES.has(yield* statusOf(thread));
        if (wasRunning) {
          const turnId = thread.session?.activeTurnId ?? thread.latestTurn?.turnId;
          yield* dispatch("interrupt the thread", {
            type: "thread.turn.interrupt",
            commandId: yield* commandId("thread-interrupt"),
            threadId: thread.id,
            ...(turnId == null ? {} : { turnId }),
            createdAt: yield* nowIso,
          });
        }
        return { thread: yield* refreshed(thread.id, scope.threadId), wasRunning };
      }),

    update_thread: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireScope;
        const thread = yield* findThread(input.threadId, { includeArchived: true });
        const isArchived = thread.archivedAt !== null;
        if (input.archived === true && !isArchived && thread.id === scope.threadId) {
          return yield* new ThreadIsCurrentThreadError({ operation: "archive" });
        }
        // Unarchive first: settle and rename are refused on an archived thread.
        if (input.archived === false && isArchived) {
          yield* dispatch("unarchive the thread", {
            type: "thread.unarchive",
            commandId: yield* commandId("thread-unarchive"),
            threadId: thread.id,
          });
        }
        if (input.title !== undefined && input.title !== thread.title) {
          yield* dispatch("rename the thread", {
            type: "thread.meta.update",
            commandId: yield* commandId("thread-rename"),
            threadId: thread.id,
            title: input.title,
          });
        }
        if (input.settled !== undefined) {
          yield* dispatch(
            input.settled ? "settle the thread" : "unsettle the thread",
            input.settled
              ? {
                  type: "thread.settle",
                  commandId: yield* commandId("thread-settle"),
                  threadId: thread.id,
                }
              : {
                  type: "thread.unsettle",
                  commandId: yield* commandId("thread-unsettle"),
                  threadId: thread.id,
                  reason: "user",
                },
          );
        }
        if (input.archived === true && !isArchived) {
          yield* dispatch("archive the thread", {
            type: "thread.archive",
            commandId: yield* commandId("thread-archive"),
            threadId: thread.id,
          });
          // Mirrors a client archive: the agent and the thread's terminals go with it.
          if (thread.session !== null && thread.session.status !== "stopped") {
            yield* dispatch("stop the archived thread's agent", {
              type: "thread.session.stop",
              commandId: yield* commandId("thread-archive-stop"),
              threadId: thread.id,
              createdAt: yield* nowIso,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to stop provider session during MCP archive", {
                  threadId: thread.id,
                  cause,
                }),
              ),
            );
          }
          yield* terminals.close({ threadId: thread.id }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to close thread terminals after MCP archive", {
                threadId: thread.id,
                error: error.message,
              }),
            ),
          );
        }
        return { thread: yield* refreshed(thread.id, scope.threadId) };
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
