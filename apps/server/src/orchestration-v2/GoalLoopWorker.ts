/**
 * Drives `/t3-goal` loops. A scheduler sweep reconciles every thread whose goal
 * needs attention: it starts the next iteration in a fresh child thread,
 * continues the child in place while its context has room, records its
 * outcome, runs the completion check, and enforces the burn guard and
 * iteration timeout. All decisions about what a finished iteration means live
 * in `GoalState.ts`; this worker only observes and reports, so restarts resume
 * from durable state.
 *
 * @module GoalLoopWorker
 */
import {
  CheckpointRef,
  CommandId,
  goalIterationTimeoutMins,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2GoalAdvanceStep,
  type OrchestrationV2GoalBurnGuard,
  type OrchestrationV2GoalStatusReason,
  type OrchestrationV2GoalUsageAccounting,
  type OrchestrationV2GoalUsageSample,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadGoal,
  type OrchestrationV2ThreadShell,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { goalIterationTitle, isLiveGoal, MAX_GOAL_CHECK_OUTPUT_CHARS } from "./GoalState.ts";
import { buildGoalIterationPrompt } from "./GoalPrompt.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";

/** The share of its time limit an iteration has left when it is asked to wrap up. */
const WRAP_UP_LEAD_FRACTION = 0.1;
/** Past this share of its context window, a finished turn hands over to a fresh iteration. */
const CONTEXT_ROLLOVER_FRACTION = 0.6;
/** How long to wait when a usage limit reports no reset time (or one already past). */
const USAGE_LIMIT_FALLBACK_BACKOFF_MS = 15 * 60 * 1000;
const CHECK_TIMEOUT = "10 minutes";
const CHECK_MAX_OUTPUT_BYTES = 256 * 1024;
const GOAL_REFS_PREFIX = "refs/t3/goals";

/** Guard pauses that should stop the running child rather than let it finish. */
const INTERRUPTING_PAUSE_REASONS: ReadonlySet<OrchestrationV2GoalStatusReason> = new Set([
  "burn_rate",
  "iteration_timeout",
]);

/** When an iteration gets its wrap-up nudge and when it is stopped, in ms after it started. */
export function iterationDeadlines(timeoutMins: number) {
  const timeoutMs = timeoutMins * 60_000;
  return { wrapUpMs: Math.round(timeoutMs * (1 - WRAP_UP_LEAD_FRACTION)), timeoutMs };
}

/**
 * Tokens one iteration's child thread spent. Every provider turn in the
 * child belongs to the iteration because the child starts empty. `tokens`
 * counts context volume (cache reads at full weight); `uncachedTokens` drops
 * cache reads, which is closer to what the turn cost.
 */
export function childIterationTokens(
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "turnTokenUsage">>,
): {
  readonly tokens: number;
  readonly uncachedTokens: number;
  readonly accounting: OrchestrationV2GoalUsageAccounting;
} {
  let tokens = 0;
  let uncachedTokens = 0;
  let reported = 0;
  let complete = true;
  for (const turn of providerTurns) {
    const usage = turn.turnTokenUsage;
    if (
      usage === undefined ||
      (usage.inputTokens === undefined && usage.outputTokens === undefined)
    ) {
      complete = false;
      continue;
    }
    reported += 1;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    tokens += input + output;
    uncachedTokens += Math.max(0, input - (usage.cachedInputTokens ?? 0)) + output;
    if (usage.usageStatus !== "complete") complete = false;
  }
  if (reported === 0) return { tokens: 0, uncachedTokens: 0, accounting: "unavailable" };
  return { tokens, uncachedTokens, accounting: complete ? "exact" : "estimated" };
}

/**
 * How full the child's context window is, from the reports the composer's
 * context meter reads: the latest turn's live usage, else the provider
 * thread's last snapshot. Null when the provider gives no window size.
 */
export function childContextFraction(
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "tokenUsage">>,
  providerThread: Pick<OrchestrationV2ProviderThread, "contextUsage"> | undefined,
): number | null {
  const threadUsage = providerThread?.contextUsage ?? null;
  const usage = providerTurns.findLast((turn) => turn.tokenUsage !== undefined)?.tokenUsage;
  const usedTokens = usage?.usedTokens ?? threadUsage?.usedTokens;
  const maxTokens = usage?.maxTokens ?? threadUsage?.maxTokens;
  if (usedTokens === undefined || maxTokens == null || maxTokens <= 0) return null;
  return usedTokens / maxTokens;
}

export interface GoalUsageSample {
  readonly atMs: number;
  readonly windows: ReadonlyArray<Pick<ServerProviderUsageWindow, "id" | "usedPercent">>;
}

/**
 * The usage window that rose most across the samples, which callers keep
 * trimmed to the guard's trailing window. A drop between samples is a
 * provider reset and restarts that window's baseline.
 */
export function largestUsageRise(
  samples: ReadonlyArray<GoalUsageSample>,
): { readonly windowId: string; readonly risePoints: number } | null {
  const latest = samples.at(-1);
  if (latest === undefined) return null;
  let largest: { readonly windowId: string; readonly risePoints: number } | null = null;
  for (const window of latest.windows) {
    let low: number | null = null;
    let previous: number | null = null;
    for (const sample of samples) {
      const value = sample.windows.find((entry) => entry.id === window.id)?.usedPercent;
      if (value === undefined) continue;
      if (low === null || (previous !== null && value < previous)) low = value;
      else low = Math.min(low, value);
      previous = value;
    }
    const risePoints = low === null ? 0 : window.usedPercent - low;
    if (largest === null || risePoints > largest.risePoints) {
      largest = { windowId: window.id, risePoints };
    }
  }
  return largest;
}

export function burnGuardTripped(
  samples: ReadonlyArray<GoalUsageSample>,
  guard: OrchestrationV2GoalBurnGuard,
): { readonly windowId: string; readonly risePoints: number } | null {
  const rise = largestUsageRise(samples);
  return rise !== null && rise.risePoints > guard.maxPercentPoints ? rise : null;
}

/** Whether a reading differs enough from the stored one to be worth persisting. */
function usageSampleChanged(
  stored: OrchestrationV2GoalUsageSample | null | undefined,
  next: OrchestrationV2GoalUsageSample,
): boolean {
  if (stored == null || stored.windows.length !== next.windows.length) return true;
  if (Math.round(stored.risePoints) !== Math.round(next.risePoints)) return true;
  return next.windows.some((window, index) => {
    const previous = stored.windows[index]!;
    return (
      previous.id !== window.id ||
      Math.round(previous.usedPercent) !== Math.round(window.usedPercent)
    );
  });
}

/** How a finished child ended, as the goal reducer understands it. */
export function childOutcome(
  resultRun: Pick<OrchestrationV2Run, "status"> | undefined,
  shell: Pick<OrchestrationV2ThreadShell, "lastErrorClass" | "usageLimitResetAt"> | null,
): {
  readonly outcome: "completed" | "failed" | "interrupted" | "usage_limited";
  readonly resumeAt: string | null;
} {
  switch (resultRun?.status) {
    case "completed":
      return { outcome: "completed", resumeAt: null };
    case "failed":
      return shell?.lastErrorClass === "usage_limit"
        ? { outcome: "usage_limited", resumeAt: shell.usageLimitResetAt ?? null }
        : { outcome: "failed", resumeAt: null };
    default:
      return { outcome: "interrupted", resumeAt: null };
  }
}

const isLiveRun = (run: OrchestrationV2Run) =>
  run.status === "preparing" || run.status === "starting" || run.status === "running";

const goalRef = (goal: OrchestrationV2ThreadGoal, iteration: number, edge: "start" | "end") =>
  CheckpointRef.make(`${GOAL_REFS_PREFIX}/${Base64Url.encode(goal.id)}/${iteration}/${edge}`);

/** The loop's sweep, plus a way to wait for in-flight completion checks. */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const checks = yield* FiberMap.make<string, void, never>();
  // Usage samples live in memory: after a restart the guard re-warms over its
  // window instead of judging a rise it did not observe.
  const usageSamples = new Map<CommandId, Array<GoalUsageSample>>();
  // Every dispatch gets a fresh command id. The goal reducer already rejects
  // stale steps, while a reused id would replay a stored rejection forever and
  // wedge the loop after one transient failure.
  const bootId = yield* randomUuidV4;
  let dispatchSequence = 0;
  const commandId = (thread: OrchestrationV2AppThread, key: string) =>
    CommandId.make(`goal:${thread.id}:${key}:${bootId}-${++dispatchSequence}`);

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(Effect.asVoid);

  const advance = (
    thread: OrchestrationV2AppThread,
    goal: OrchestrationV2ThreadGoal,
    key: string,
    step: OrchestrationV2GoalAdvanceStep,
  ) =>
    dispatch({
      type: "thread.goal.advance",
      commandId: commandId(thread, `${goal.iteration}:${key}`),
      threadId: thread.id,
      goalId: goal.id,
      iteration: goal.iteration,
      step,
    });

  const workspaceCwd = (thread: OrchestrationV2AppThread) =>
    thread.worktreePath === null
      ? projects.get(thread.projectId).pipe(
          Effect.map(
            Option.match({ onNone: () => null, onSome: (project) => project.workspaceRoot }),
          ),
          Effect.orElseSucceed(() => null),
        )
      : Effect.succeed(thread.worktreePath);

  const checkpointOps = (cwd: string | null) =>
    cwd === null
      ? Effect.succeed(null)
      : vcs.detect({ cwd, requestedKind: "auto" }).pipe(
          Effect.map((handle) => handle?.driver.checkpoints ?? null),
          Effect.orElseSucceed(() => null),
        );

  const captureRef = (cwd: string | null, ref: CheckpointRef) =>
    Effect.gen(function* () {
      const ops = yield* checkpointOps(cwd);
      if (ops === null || cwd === null) return false;
      return yield* ops.captureCheckpoint({ cwd, checkpointRef: ref }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    });

  const workspaceChanged = (
    thread: OrchestrationV2AppThread,
    goal: OrchestrationV2ThreadGoal,
    baselineRef: CheckpointRef | null,
  ) =>
    Effect.gen(function* () {
      if (baselineRef === null) return null;
      const cwd = yield* workspaceCwd(thread);
      const endRef = goalRef(goal, goal.iteration, "end");
      if (!(yield* captureRef(cwd, endRef))) return null;
      const ops = yield* checkpointOps(cwd);
      if (ops === null || cwd === null) return null;
      const changed = yield* ops
        .diffCheckpoints({
          cwd,
          fromCheckpointRef: baselineRef,
          toCheckpointRef: endRef,
          ignoreWhitespace: false,
          format: "numstat",
        })
        .pipe(
          Effect.map((diff) => diff.trim().length > 0),
          Effect.orElseSucceed(() => null),
        );
      yield* ops
        .deleteCheckpointRefs({ cwd, checkpointRefs: [baselineRef, endRef] })
        .pipe(Effect.ignore);
      return changed;
    });

  const startIteration = (thread: OrchestrationV2AppThread, goal: OrchestrationV2ThreadGoal) =>
    Effect.gen(function* () {
      const iteration = goal.iteration + 1;
      const cwd = yield* workspaceCwd(thread);
      const startRef = goalRef(goal, iteration, "start");
      const baselineRef = (yield* captureRef(cwd, startRef)) ? startRef : null;
      yield* orchestrator
        .dispatch({
          type: "thread.goal.iteration.start",
          commandId: commandId(thread, `${iteration}:start`),
          threadId: thread.id,
          goalId: goal.id,
          iteration,
          baselineRef,
          prompt: buildGoalIterationPrompt(goal, iteration),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.goal-loop.start-failed", {
              threadId: thread.id,
              cause,
            }).pipe(
              Effect.andThen(
                advance(thread, goal, "start-failed", {
                  type: "paused",
                  reason: "child_failed",
                }),
              ),
            ),
          ),
        );
    });

  const runCheck = (thread: OrchestrationV2AppThread, goal: OrchestrationV2ThreadGoal) =>
    Effect.gen(function* () {
      const command = goal.checkCommand!;
      const cwd = yield* workspaceCwd(thread);
      const environment = yield* HostProcess.Environment;
      const shell = (yield* HostProcess.isWindows)
        ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] }
        : { command: environment.SHELL ?? "/bin/sh", args: ["-lc", command] };
      const output = yield* processRunner
        .run({
          ...shell,
          cwd: cwd ?? undefined,
          timeout: CHECK_TIMEOUT,
          maxOutputBytes: CHECK_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      if (Option.isNone(output)) {
        return yield* advance(thread, goal, "check-error", {
          type: "paused",
          reason: "check_error",
        });
      }
      const { stdout, stderr, code, timedOut } = output.value;
      const exitCode = code === null ? null : Number(code);
      const combined = [stdout, stderr].filter((text) => text.trim().length > 0).join("\n");
      yield* advance(thread, goal, "check", {
        type: "check_finished",
        result: {
          iteration: goal.iteration,
          command,
          exitCode,
          timedOut,
          passed: !timedOut && exitCode === 0,
          outputTail: combined.slice(-MAX_GOAL_CHECK_OUTPUT_CHARS),
          at: DateTime.formatIso(yield* DateTime.now),
        },
      });
    });

  const burnGuardCheck = (
    thread: OrchestrationV2AppThread,
    goal: OrchestrationV2ThreadGoal,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const guard = goal.burnGuard;
      if (guard === null) return null;
      const provider = (yield* providers.getProviders).find(
        (candidate) => candidate.instanceId === goal.modelSelection.instanceId,
      );
      const windows = (provider?.usageLimits?.windows ?? []).map(({ id, usedPercent }) => ({
        id,
        usedPercent,
      }));
      if (windows.length === 0) {
        yield* Effect.logDebug("orchestration-v2.goal-loop.usage-unavailable", {
          threadId: thread.id,
          instanceId: goal.modelSelection.instanceId,
        });
        return null;
      }
      const cutoff = nowMs - guard.windowMins * 60_000;
      const samples = (usageSamples.get(goal.id) ?? []).filter((sample) => sample.atMs >= cutoff);
      samples.push({ atMs: nowMs, windows });
      usageSamples.set(goal.id, samples);
      const rise = largestUsageRise(samples);
      const sample: OrchestrationV2GoalUsageSample = {
        at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        windows,
        risePoints: rise?.risePoints ?? 0,
      };
      yield* Effect.logDebug("orchestration-v2.goal-loop.usage-sample", {
        threadId: thread.id,
        samples: samples.length,
        ...sample,
      });
      if (usageSampleChanged(goal.usageSample, sample)) {
        yield* advance(thread, goal, "usage-sampled", { type: "usage_sampled", sample });
      }
      return burnGuardTripped(samples, guard);
    });

  /**
   * Starts another turn in the iteration's thread when its last turn ended
   * cleanly, recorded progress, and left both time and context to spare, so
   * the agent keeps its context instead of re-orienting in a fresh thread.
   * Returns false when the iteration should end; unknown context size keeps
   * the fresh-thread behaviour.
   */
  const continueInPlace = (
    thread: OrchestrationV2AppThread,
    goal: OrchestrationV2ThreadGoal,
    records: ProjectionStore.ProjectionRecords<"runs" | "providerThreads" | "providerTurns">,
    progress: ReturnType<typeof delegatedTaskProgress>,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const current = goal.current!;
      const endedRun = progress.resultRun;
      if (
        goal.status !== "active" ||
        current.claim !== null ||
        current.wrapUpSentAt != null ||
        endedRun?.status !== "completed" ||
        endedRun.startedAt === null ||
        nowMs - Date.parse(current.startedAt) >
          iterationDeadlines(goalIterationTimeoutMins(goal)).wrapUpMs
      ) {
        return false;
      }
      // A turn that left no note is not obviously progressing; let a fresh
      // iteration take over rather than prompting it again.
      const turnStartedMs = DateTime.toEpochMillis(endedRun.startedAt);
      if (
        !goal.progressNotes.some(
          (note) => note.iteration === current.iteration && Date.parse(note.at) >= turnStartedMs,
        )
      ) {
        return false;
      }
      const fraction = childContextFraction(
        records.providerTurns,
        records.providerThreads.find(
          (providerThread) => providerThread.id === records.thread.activeProviderThreadId,
        ),
      );
      if (fraction === null || fraction >= CONTEXT_ROLLOVER_FRACTION) return false;
      const pendingMessages = current.pendingMessages ?? [];
      const sent = yield* dispatch({
        type: "message.dispatch",
        commandId: commandId(thread, `${goal.iteration}:continue`),
        messageId: MessageId.make(
          `goal-continue:${current.childThreadId}:${bootId}-${dispatchSequence}`,
        ),
        threadId: current.childThreadId,
        text: [
          ...pendingMessages.map((message) => message.text),
          "Continue from T3 Code: this goal iteration still has time and context to spare, so keep working toward the goal in this thread. If the goal is achieved, call t3_goal_complete. Otherwise rewrite the handoff file and call t3_goal_update before your turn ends.",
        ].join("\n\n"),
        attachments: [],
        deliveryIntent: "auto",
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.goal-loop.continue-failed", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!sent) return false;
      yield* Effect.logDebug("orchestration-v2.goal-loop.continued", {
        threadId: thread.id,
        iteration: goal.iteration,
        contextFraction: fraction,
      });
      if (pendingMessages.length > 0) {
        yield* advance(thread, goal, "messages-delivered", {
          type: "messages_delivered",
          count: pendingMessages.length,
        });
      }
      yield* advance(thread, goal, "continued", { type: "turn_continued" });
      return true;
    });

  const reconcileRunning = (
    thread: OrchestrationV2AppThread,
    goal: OrchestrationV2ThreadGoal,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const current = goal.current!;
      if (current.phase === "checking") {
        if (goal.status === "stopped") {
          // Stop the process before retiring the durable check. A late passing
          // result must not keep running after Stop or owner deletion.
          yield* FiberMap.remove(checks, `${goal.id}:${goal.iteration}`);
          return yield* advance(thread, goal, "check", {
            type: "check_finished",
            result: {
              iteration: goal.iteration,
              command: goal.checkCommand ?? "check",
              exitCode: null,
              timedOut: false,
              passed: false,
              outputTail: "The goal was stopped before the check ran.",
              at: DateTime.formatIso(yield* DateTime.now),
            },
          });
        }
        if (goal.status === "paused" && goal.statusReason === "check_error") return;
        yield* FiberMap.run(
          checks,
          `${goal.id}:${goal.iteration}`,
          runCheck(thread, goal).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.goal-loop.check-failed", {
                threadId: thread.id,
                cause,
              }),
            ),
          ),
          {
            onlyIfMissing: true,
          },
        );
        return;
      }

      const child = yield* orchestrator
        .getThreadRecords(current.childThreadId, [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
        ])
        .pipe(Effect.option);
      // Finished iterations are named for what they did, from their last note.
      const lastNote = goal.progressNotes.findLast((note) => note.iteration === current.iteration);
      const finish = (
        step: Omit<Extract<OrchestrationV2GoalAdvanceStep, { type: "iteration_finished" }>, "type">,
      ) =>
        advance(thread, goal, "finished", { type: "iteration_finished", ...step }).pipe(
          Effect.andThen(
            lastNote === undefined
              ? Effect.void
              : dispatch({
                  type: "thread.metadata.update",
                  commandId: commandId(thread, `${goal.iteration}:retitle`),
                  threadId: current.childThreadId,
                  title: goalIterationTitle(current.iteration, lastNote.text),
                }),
          ),
          Effect.andThen(
            dispatch({
              type: "thread.settle",
              commandId: commandId(thread, `${goal.iteration}:settle-child`),
              threadId: current.childThreadId,
            }),
          ),
        );
      if (Option.isNone(child)) {
        // Only a child that is really gone ends the iteration; a failed read
        // retries on the next sweep instead of abandoning a running agent.
        const childShell = yield* orchestrator
          .getThreadShell(current.childThreadId)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (childShell !== null) return;
      }
      if (Option.isNone(child) || child.value.thread.deletedAt !== null) {
        return yield* finish({
          childOutcome: "interrupted",
          tokens: 0,
          accounting: "unavailable",
          workspaceChanged: yield* workspaceChanged(thread, goal, current.baselineRef),
          resumeAt: null,
        });
      }
      const records = child.value;

      const pending = records.runtimeRequests.find((request) => request.status === "pending");
      if (pending !== undefined && current.waitingOnRequest?.requestId !== pending.id) {
        yield* advance(thread, goal, `waiting:${pending.id}`, {
          type: "child_waiting",
          requestId: pending.id,
          kind: pending.kind,
        });
      } else if (pending === undefined && current.waitingOnRequest !== null) {
        yield* advance(thread, goal, `resumed:${current.waitingOnRequest.requestId}`, {
          type: "child_resumed",
        });
      }

      const progress = delegatedTaskProgress(records);
      const stillWorking =
        progress.state !== "result_available" ||
        records.runs.some((run) => run.status === "queued" && run.queueHeld !== true);
      const interrupting =
        goal.status === "stopped" ||
        current.timedOutAt != null ||
        (goal.status === "paused" &&
          goal.statusReason !== null &&
          INTERRUPTING_PAUSE_REASONS.has(goal.statusReason));
      if (stillWorking) {
        const liveRuns = records.runs.filter(isLiveRun);
        if (interrupting) {
          if (
            records.runs.some(
              (run) =>
                isLiveRun(run) ||
                run.status === "waiting" ||
                (run.status === "queued" && run.queueHeld !== true),
            )
          ) {
            yield* dispatch({
              type: "thread.stop",
              commandId: commandId(thread, `${goal.iteration}:stop-child`),
              threadId: current.childThreadId,
              reason:
                current.timedOutAt != null
                  ? "This goal iteration reached its time limit."
                  : "Goal loop stopped this iteration.",
            });
            return;
          }
          // Nothing left to interrupt (only background work remains): close
          // the iteration now rather than waiting on work nobody wants.
        } else {
          const pendingMessages = current.pendingMessages ?? [];
          if (pendingMessages.length > 0) {
            yield* dispatch({
              type: "message.dispatch",
              commandId: commandId(thread, `${goal.iteration}:user-message`),
              messageId: MessageId.make(
                `goal-message:${current.childThreadId}:${bootId}-${dispatchSequence}`,
              ),
              threadId: current.childThreadId,
              text: pendingMessages.map((message) => message.text).join("\n\n"),
              attachments: [],
              deliveryIntent: "auto",
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "server",
            });
            yield* advance(thread, goal, "messages-delivered", {
              type: "messages_delivered",
              count: pendingMessages.length,
            });
          }
          if (goal.status === "active") {
            const elapsedMs = nowMs - Date.parse(current.startedAt);
            const deadlines = iterationDeadlines(goalIterationTimeoutMins(goal));
            if (elapsedMs > deadlines.timeoutMs) {
              return yield* advance(thread, goal, "timed-out", { type: "timed_out" });
            }
            // Only a live turn can take the nudge; with no turn running it
            // would start a fresh one.
            if (
              elapsedMs > deadlines.wrapUpMs &&
              current.wrapUpSentAt == null &&
              liveRuns.length > 0
            ) {
              const minutesLeft = Math.max(
                1,
                Math.round((deadlines.timeoutMs - elapsedMs) / 60_000),
              );
              // Steering only: queued behind the turn it would start a new one.
              yield* dispatch({
                type: "message.dispatch",
                commandId: commandId(thread, `${goal.iteration}:wrap-up`),
                messageId: MessageId.make(
                  `goal-wrap-up:${current.childThreadId}:${bootId}-${dispatchSequence}`,
                ),
                threadId: current.childThreadId,
                text: `Time check from T3 Code: this goal iteration will be stopped in about ${minutesLeft} minutes. Finish or checkpoint the current step, rewrite the handoff file, call t3_goal_update with a short note, and end your turn. The next iteration continues from there.`,
                attachments: [],
                deliveryIntent: "steer",
                dispatchMode: { type: "start_immediately" },
                createdBy: "agent",
                creationSource: "server",
              });
              yield* advance(thread, goal, "wrap-up-sent", { type: "wrap_up_sent" });
            }
            const tripped = yield* burnGuardCheck(thread, goal, nowMs);
            if (tripped !== null) {
              yield* Effect.logInfo("orchestration-v2.goal-loop.burn-guard-tripped", {
                threadId: thread.id,
                maxPercentPoints: goal.burnGuard?.maxPercentPoints,
                windowMins: goal.burnGuard?.windowMins,
                ...tripped,
              });
              return yield* advance(thread, goal, "paused:burn", {
                type: "paused",
                reason: "burn_rate",
              });
            }
          }
          return;
        }
      }

      if (!interrupting && (yield* continueInPlace(thread, goal, records, progress, nowMs))) return;

      const shell = yield* orchestrator
        .getThreadShell(current.childThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      const ended = childOutcome(progress.resultRun, shell);
      const usage = childIterationTokens(records.providerTurns);
      // Without a future reset time, back off rather than relaunching a child
      // that will hit the same limit on the next sweep.
      const resumeAt =
        ended.outcome !== "usage_limited"
          ? null
          : ended.resumeAt !== null && Date.parse(ended.resumeAt) > nowMs
            ? ended.resumeAt
            : DateTime.formatIso(DateTime.makeUnsafe(nowMs + USAGE_LIMIT_FALLBACK_BACKOFF_MS));
      yield* finish({
        childOutcome: ended.outcome,
        tokens: usage.tokens,
        uncachedTokens: usage.uncachedTokens,
        accounting: usage.accounting,
        workspaceChanged: yield* workspaceChanged(thread, goal, current.baselineRef),
        resumeAt,
      });
    });

  const reconcile = (thread: OrchestrationV2AppThread, nowMs: number) =>
    Effect.gen(function* () {
      const goal = thread.goal;
      if (goal == null) return;
      if (goal.status !== "active") usageSamples.delete(goal.id);
      if ((thread.archivedAt !== null || thread.deletedAt !== null) && isLiveGoal(goal)) {
        return yield* advance(thread, goal, "stopped:parent", {
          type: "stopped",
          reason: "parent_unavailable",
        });
      }
      if (goal.current !== null) return yield* reconcileRunning(thread, goal, nowMs);
      if (goal.status === "usageLimited") {
        if (goal.resumeAt === null || Date.parse(goal.resumeAt) <= nowMs) {
          yield* advance(thread, goal, `resumed:limit:${goal.resumeAt ?? "now"}`, {
            type: "resumed",
          });
        }
        return;
      }
      if (goal.status === "active") yield* startIteration(thread, goal);
    });

  const sweep = Effect.fn("GoalLoopWorker.sweep")(function* () {
    const threads = yield* projections.getGoalThreads();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const liveGoalIds = new Set(threads.flatMap((thread) => (thread.goal ? [thread.goal.id] : [])));
    for (const goalId of usageSamples.keys()) {
      if (!liveGoalIds.has(goalId)) usageSamples.delete(goalId);
    }
    yield* Effect.forEach(
      threads,
      (thread) =>
        reconcile(thread, nowMs).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.goal-loop.reconcile-failed", {
              threadId: thread.id,
              cause,
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });
  return { sweep, awaitChecks: FiberMap.awaitEmpty(checks) };
});

// Due work is derived from goals persisted on threads, so a restart resumes
// every loop without restoring timers.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { sweep } = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("goal-loop", sweep());
  }),
);
