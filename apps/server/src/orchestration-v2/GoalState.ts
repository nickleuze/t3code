/**
 * Pure rules for `/t3-goal` loops. Every goal command flows through
 * `applyGoalCommand`, which returns the next goal state or a rejection
 * reason; the orchestrator persists the result as thread metadata.
 *
 * @module GoalState
 */
import type {
  CheckpointRef,
  CommandId,
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2GoalAdvanceStep,
  OrchestrationV2GoalBurnGuard,
  OrchestrationV2GoalCheckResult,
  OrchestrationV2GoalIterationOutcome,
  OrchestrationV2GoalIterationRecord,
  OrchestrationV2GoalProgressNote,
  OrchestrationV2GoalProposal,
  OrchestrationV2GoalStatus,
  OrchestrationV2GoalUsageAccounting,
  OrchestrationV2ThreadGoal,
  OrchestrationV2ThreadGoalSummary,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

export const DEFAULT_GOAL_NO_PROGRESS_LIMIT = 3;
export const DEFAULT_GOAL_SAFETY_CAP = 100;
export const DEFAULT_GOAL_BURN_GUARD: OrchestrationV2GoalBurnGuard = {
  maxPercentPoints: 20,
  windowMins: 60,
};
export const MAX_GOAL_NOTE_CHARS = 2_000;
export const MAX_GOAL_NOTES_TOTAL_CHARS = 8_000;
export const MAX_GOAL_HISTORY = 20;
export const MAX_GOAL_CHECK_OUTPUT_CHARS = 4_000;
export const DEFAULT_GOAL_ITERATION_TIMEOUT_MINS = 120;
const MAX_GOAL_USER_MESSAGE_CHARS = 4_000;
const SHELL_SUMMARY_CHARS = 200;
const SHELL_OBJECTIVE_CHARS = 120;

const LIVE_STATUSES: ReadonlySet<OrchestrationV2GoalStatus> = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
]);

/** A goal that can still start or finish iterations. */
export function isLiveGoal(goal: OrchestrationV2ThreadGoal | null | undefined): boolean {
  return goal != null && LIVE_STATUSES.has(goal.status);
}

export type GoalCommandInput =
  | {
      readonly type: "set";
      readonly commandId: CommandId;
      readonly objective: string;
      readonly checkCommand: string | null;
      readonly burnGuard: OrchestrationV2GoalBurnGuard | null | undefined;
      readonly noProgressLimit: number | undefined;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly doneWhen: string | null;
      readonly background: string | null;
      readonly permissions: string | null;
      readonly iterationTimeoutMins: number | undefined;
    }
  | {
      readonly type: "message";
      readonly goalId: CommandId;
      readonly text: string;
    }
  | {
      readonly type: "control";
      readonly goalId: CommandId;
      readonly action: "pause" | "resume" | "stop" | "clear";
      readonly burnGuard: OrchestrationV2GoalBurnGuard | null | undefined;
    }
  | {
      readonly type: "iteration.start";
      readonly goalId: CommandId;
      readonly iteration: number;
      readonly childThreadId: ThreadId;
      readonly baselineRef: CheckpointRef | null;
    }
  | {
      readonly type: "report";
      readonly goalId: CommandId;
      readonly iteration: number;
      readonly childThreadId: ThreadId;
      readonly report:
        | {
            readonly type: "note";
            readonly text: string;
            readonly handoffPath?: string | undefined;
          }
        | {
            readonly type: "claim";
            readonly status: "complete" | "blocked";
            readonly summary: string;
          };
    }
  | {
      readonly type: "advance";
      readonly goalId: CommandId;
      readonly iteration: number;
      readonly step: OrchestrationV2GoalAdvanceStep;
    };

export type GoalCommandResult =
  | { readonly ok: true; readonly goal: OrchestrationV2ThreadGoal | null }
  | { readonly ok: false; readonly reason: string };

const reject = (reason: string): GoalCommandResult => ({ ok: false, reason });
const accept = (goal: OrchestrationV2ThreadGoal | null): GoalCommandResult => ({ ok: true, goal });

/** Iteration threads are named for the goal until their own notes say what they did. */
export function goalIterationTitle(iteration: number, detail: string): string {
  const firstLine = detail.split("\n")[0]!.trim();
  const clipped = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  return `Goal #${iteration}: ${clipped}`;
}

export function goalIterationTimeoutMins(
  goal: Pick<OrchestrationV2ThreadGoal, "iterationTimeoutMins">,
) {
  return goal.iterationTimeoutMins ?? DEFAULT_GOAL_ITERATION_TIMEOUT_MINS;
}

export type GoalProposalCommandInput =
  | { readonly type: "propose"; readonly proposal: OrchestrationV2GoalProposal }
  | { readonly type: "dismiss"; readonly proposalId: CommandId };

export type GoalProposalCommandResult =
  | { readonly ok: true; readonly proposal: OrchestrationV2GoalProposal | null }
  | { readonly ok: false; readonly reason: string };

/**
 * A thread holds at most one proposal, and only while it could start a goal.
 * A new proposal replaces the old one; dismissing a proposal that is already
 * gone succeeds so a repeated click does not error.
 */
export function applyGoalProposalCommand(
  thread: Pick<
    OrchestrationV2AppThread,
    "goal" | "goalIteration" | "goalProposal" | "lineage" | "archivedAt"
  >,
  command: GoalProposalCommandInput,
): GoalProposalCommandResult {
  const current = thread.goalProposal ?? null;
  if (command.type === "dismiss") {
    return { ok: true, proposal: current?.id === command.proposalId ? null : current };
  }
  if (thread.archivedAt !== null)
    return { ok: false, reason: "Archived threads cannot run a goal." };
  if (thread.goalIteration != null || thread.lineage.relationshipToParent === "subagent") {
    return {
      ok: false,
      reason: "Goal iterations and subagent threads cannot propose goals of their own.",
    };
  }
  if (isLiveGoal(thread.goal)) {
    return {
      ok: false,
      reason:
        "This thread already runs a goal. Message it through the goal instead of proposing another.",
    };
  }
  return { ok: true, proposal: command.proposal };
}

/**
 * Applies one goal command to the thread's current goal. `now` is an ISO
 * timestamp; callers compare `result.goal.status` with the previous status to
 * decide whether the thread itself counts as updated.
 */
export function applyGoalCommand(
  thread: Pick<OrchestrationV2AppThread, "goal" | "goalIteration" | "lineage" | "archivedAt">,
  command: GoalCommandInput,
  now: string,
): GoalCommandResult {
  const goal = thread.goal ?? null;
  if (command.type === "set") {
    if (thread.archivedAt !== null) return reject("Archived threads cannot run a goal.");
    if (thread.goalIteration != null || thread.lineage.relationshipToParent === "subagent") {
      return reject("Goal iterations and subagent threads cannot run their own goal.");
    }
    if (isLiveGoal(goal)) {
      return reject("This thread already has a goal. Stop or clear it first.");
    }
    if (goal?.current != null) {
      return reject("Wait for the stopped goal's last iteration to finish.");
    }
    return accept({
      id: command.commandId,
      objective: command.objective,
      status: "active",
      statusReason: null,
      checkCommand: command.checkCommand,
      burnGuard: command.burnGuard === undefined ? DEFAULT_GOAL_BURN_GUARD : command.burnGuard,
      noProgressLimit: command.noProgressLimit ?? DEFAULT_GOAL_NO_PROGRESS_LIMIT,
      consecutiveNoProgress: 0,
      safetyCap: DEFAULT_GOAL_SAFETY_CAP,
      iteration: 0,
      tokensUsed: 0,
      usageAccounting: "exact",
      modelSelection: command.modelSelection,
      runtimeMode: command.runtimeMode,
      progressNotes: [],
      current: null,
      lastCheck: null,
      history: [],
      resumeAt: null,
      completedSummary: null,
      doneWhen: command.doneWhen,
      background: command.background,
      permissions: command.permissions,
      iterationTimeoutMins: command.iterationTimeoutMins ?? DEFAULT_GOAL_ITERATION_TIMEOUT_MINS,
      handoffPath: null,
      resumeNote: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (goal === null || goal.id !== command.goalId) {
    return reject("That goal is no longer on this thread.");
  }
  const touch = (next: Omit<OrchestrationV2ThreadGoal, "updatedAt">): GoalCommandResult =>
    accept({ ...next, updatedAt: now });

  switch (command.type) {
    case "control":
      return applyControl(goal, command, now, touch);
    case "message":
      return applyMessage(goal, command.text, now, touch);
    case "iteration.start": {
      if (goal.status !== "active") return reject("The goal is not active.");
      if (goal.current !== null) return reject("An iteration is already running.");
      if (command.iteration !== goal.iteration + 1) return reject("Stale iteration number.");
      if (command.iteration > goal.safetyCap) return reject("The goal reached its safety cap.");
      if (thread.archivedAt !== null) return reject("Archived threads cannot run a goal.");
      return touch({
        ...goal,
        iteration: command.iteration,
        // The iteration's opening prompt carries the note, so it is consumed here.
        resumeNote: null,
        current: {
          iteration: command.iteration,
          childThreadId: command.childThreadId,
          startedAt: now,
          phase: "running",
          baselineRef: command.baselineRef,
          notesThisIteration: 0,
          claim: null,
          waitingOnRequest: null,
          finished: null,
        },
      });
    }
    case "report": {
      const current = goal.current;
      if (
        current === null ||
        current.iteration !== command.iteration ||
        current.childThreadId !== command.childThreadId ||
        current.finished !== null ||
        (goal.status !== "active" && goal.status !== "paused")
      ) {
        return reject("This thread is not running the current goal iteration.");
      }
      if (command.report.type === "note") {
        return touch({
          ...goal,
          progressNotes: appendNote(goal.progressNotes, {
            iteration: command.iteration,
            text: command.report.text.slice(0, MAX_GOAL_NOTE_CHARS),
            at: now,
          }),
          ...(command.report.handoffPath === undefined
            ? {}
            : { handoffPath: command.report.handoffPath }),
          current: { ...current, notesThisIteration: current.notesThisIteration + 1 },
        });
      }
      return touch({
        ...goal,
        current: {
          ...current,
          claim: {
            status: command.report.status,
            summary: command.report.summary.slice(0, MAX_GOAL_NOTE_CHARS),
            at: now,
          },
        },
      });
    }
    case "advance":
      return applyAdvance(goal, command.iteration, command.step, now, touch);
  }
}

/**
 * The fields a resume changes. A blocked goal's summary moves into the resume
 * note so the next iteration knows why the last one stopped, and the stale
 * summary stops showing while the goal works again.
 */
function resumedGoal(
  goal: OrchestrationV2ThreadGoal,
  userMessage: string | null,
  now: string,
): Omit<OrchestrationV2ThreadGoal, "updatedAt"> {
  return {
    ...goal,
    status: "active",
    statusReason: null,
    consecutiveNoProgress: 0,
    resumeAt: null,
    completedSummary: null,
    resumeNote: withResumeNote(
      goal,
      userMessage,
      goal.status === "blocked" ? goal.completedSummary : null,
      now,
    ),
    // Resuming past the cap grants another full allowance.
    safetyCap:
      goal.iteration >= goal.safetyCap ? goal.iteration + DEFAULT_GOAL_SAFETY_CAP : goal.safetyCap,
  };
}

function withResumeNote(
  goal: OrchestrationV2ThreadGoal,
  userMessage: string | null,
  blockedSummary: string | null,
  now: string,
): OrchestrationV2ThreadGoal["resumeNote"] {
  const previous = goal.resumeNote ?? null;
  const messages = [previous?.userMessage, userMessage].filter(
    (text): text is string => text != null && text.length > 0,
  );
  const combinedMessage =
    messages.length === 0 ? null : messages.join("\n\n").slice(-MAX_GOAL_USER_MESSAGE_CHARS);
  const combinedSummary = blockedSummary ?? previous?.blockedSummary ?? null;
  if (combinedMessage === null && combinedSummary === null) return null;
  return { userMessage: combinedMessage, blockedSummary: combinedSummary, at: now };
}

function applyMessage(
  goal: OrchestrationV2ThreadGoal,
  text: string,
  now: string,
  touch: (next: Omit<OrchestrationV2ThreadGoal, "updatedAt">) => GoalCommandResult,
): GoalCommandResult {
  if (!isLiveGoal(goal)) return reject("This goal has ended. Start a new one with /t3-goal.");
  const current = goal.current;
  if (
    goal.status === "active" &&
    current !== null &&
    current.phase === "running" &&
    current.finished === null
  ) {
    // The loop delivers it into the running iteration on its next pass.
    return touch({
      ...goal,
      current: {
        ...current,
        pendingMessages: [...(current.pendingMessages ?? []), { text, at: now }],
      },
    });
  }
  if (goal.status === "paused" || goal.status === "blocked") {
    return touch(resumedGoal(goal, text, now));
  }
  // Usage-limited goals resume on their own; between iterations or during a
  // check, the message waits for the next iteration.
  return touch({ ...goal, resumeNote: withResumeNote(goal, text, null, now) });
}

function applyControl(
  goal: OrchestrationV2ThreadGoal,
  command: Extract<GoalCommandInput, { readonly type: "control" }>,
  now: string,
  touch: (next: Omit<OrchestrationV2ThreadGoal, "updatedAt">) => GoalCommandResult,
): GoalCommandResult {
  switch (command.action) {
    case "pause":
      if (goal.status === "paused") return accept(goal);
      if (goal.status !== "active" && goal.status !== "usageLimited") {
        return reject("Only an active goal can be paused.");
      }
      return touch({ ...goal, status: "paused", statusReason: "user" });
    case "resume":
      if (goal.status === "active") return accept(goal);
      if (!isLiveGoal(goal)) return reject("A finished goal cannot be resumed.");
      return touch({
        ...resumedGoal(goal, null, now),
        ...(command.burnGuard === undefined ? {} : { burnGuard: command.burnGuard }),
      });
    case "stop":
      if (goal.status === "stopped") return accept(goal);
      if (!isLiveGoal(goal)) return reject("The goal has already ended.");
      return touch({ ...goal, status: "stopped", statusReason: "user" });
    case "clear":
      if (goal.current !== null) {
        return reject("Wait for the running iteration to finish before clearing the goal.");
      }
      if (goal.status === "active" || goal.status === "usageLimited") {
        return reject("Pause or stop the goal before clearing it.");
      }
      return accept(null);
  }
}

function applyAdvance(
  goal: OrchestrationV2ThreadGoal,
  iteration: number,
  step: OrchestrationV2GoalAdvanceStep,
  now: string,
  touch: (next: Omit<OrchestrationV2ThreadGoal, "updatedAt">) => GoalCommandResult,
): GoalCommandResult {
  if (iteration !== goal.iteration) return reject("Stale iteration number.");
  const current = goal.current;
  switch (step.type) {
    case "paused":
      if (goal.status !== "active" && goal.status !== "usageLimited") return accept(goal);
      return touch({ ...goal, status: "paused", statusReason: step.reason });
    case "stopped":
      if (!isLiveGoal(goal)) return accept(goal);
      return touch({ ...goal, status: "stopped", statusReason: step.reason });
    case "resumed":
      if (goal.status !== "usageLimited") return accept(goal);
      return touch({ ...goal, status: "active", statusReason: null, resumeAt: null });
    case "messages_delivered": {
      if (current === null) return reject("No iteration is running.");
      return touch({
        ...goal,
        current: { ...current, pendingMessages: (current.pendingMessages ?? []).slice(step.count) },
      });
    }
    case "wrap_up_sent":
    case "timed_out": {
      if (current === null || current.finished !== null) return reject("No iteration is running.");
      return touch({
        ...goal,
        current:
          step.type === "wrap_up_sent"
            ? { ...current, wrapUpSentAt: current.wrapUpSentAt ?? now }
            : { ...current, timedOutAt: current.timedOutAt ?? now },
      });
    }
    case "child_waiting":
    case "child_resumed": {
      if (current === null) return reject("No iteration is running.");
      const waitingOnRequest =
        step.type === "child_waiting" ? { requestId: step.requestId, kind: step.kind } : null;
      if (current.waitingOnRequest?.requestId === waitingOnRequest?.requestId) return accept(goal);
      return touch({ ...goal, current: { ...current, waitingOnRequest } });
    }
    case "iteration_finished": {
      if (current === null || current.finished !== null) return reject("No iteration is running.");
      const withUsage = {
        ...goal,
        tokensUsed: goal.tokensUsed + step.tokens,
        usageAccounting:
          goal.history.length === 0
            ? step.accounting
            : worseAccounting(goal.usageAccounting, step.accounting),
      };
      const finished = { tokens: step.tokens, workspaceChanged: step.workspaceChanged };
      const claim = current.claim;
      if (
        step.childOutcome === "completed" &&
        claim?.status === "complete" &&
        goal.checkCommand !== null &&
        goal.status !== "stopped"
      ) {
        return touch({ ...withUsage, current: { ...current, phase: "checking", finished } });
      }
      return touch(finishIteration(withUsage, step, finished, now));
    }
    case "check_finished": {
      if (current === null || current.phase !== "checking" || current.finished === null) {
        return reject("No check is running.");
      }
      const result: OrchestrationV2GoalCheckResult = {
        ...step.result,
        outputTail: step.result.outputTail.slice(-MAX_GOAL_CHECK_OUTPUT_CHARS),
      };
      const withCheck = { ...goal, lastCheck: result };
      if (result.passed) {
        return touch(
          closeIteration(withCheck, "claimed_complete", current.finished, now, {
            status: goal.status === "stopped" ? "stopped" : "complete",
            statusReason: goal.status === "stopped" ? goal.statusReason : null,
            completedSummary: current.claim?.summary ?? null,
          }),
        );
      }
      return touch(
        withNoProgressRule(
          closeIteration(withCheck, "check_failed", current.finished, now, {}),
          madeProgress(current.notesThisIteration, current.finished.workspaceChanged),
        ),
      );
    }
  }
}

function finishIteration(
  goal: OrchestrationV2ThreadGoal,
  step: Extract<OrchestrationV2GoalAdvanceStep, { readonly type: "iteration_finished" }>,
  finished: { readonly tokens: number; readonly workspaceChanged: boolean | null },
  now: string,
): Omit<OrchestrationV2ThreadGoal, "updatedAt"> {
  const current = goal.current!;
  // A pause or stop the user (or a guard) already chose outranks whatever the
  // child's ending would otherwise decide.
  const settled = goal.status !== "active";
  switch (step.childOutcome) {
    case "failed":
      return closeIteration(
        goal,
        "failed",
        finished,
        now,
        settled ? {} : { status: "paused", statusReason: "child_failed" },
      );
    case "interrupted":
      // Running out of time is routine: the next iteration picks up from the
      // notes, and only repeated timeouts without progress pause the goal.
      if (current.timedOutAt != null) {
        return withNoProgressRule(
          closeIteration(goal, "timed_out", finished, now, {}),
          madeProgress(current.notesThisIteration, finished.workspaceChanged),
        );
      }
      return closeIteration(
        goal,
        "interrupted",
        finished,
        now,
        settled ? {} : { status: "paused", statusReason: "child_interrupted" },
      );
    case "usage_limited":
      return closeIteration(
        goal,
        "usage_limited",
        finished,
        now,
        settled ? {} : { status: "usageLimited", statusReason: null, resumeAt: step.resumeAt },
      );
    case "completed": {
      const claim = current.claim;
      if (claim?.status === "blocked") {
        return closeIteration(
          goal,
          "blocked",
          finished,
          now,
          goal.status === "stopped"
            ? {}
            : { status: "blocked", statusReason: "agent", completedSummary: claim.summary },
        );
      }
      if (claim?.status === "complete") {
        return closeIteration(
          goal,
          "claimed_complete",
          finished,
          now,
          goal.status === "stopped"
            ? {}
            : { status: "complete", statusReason: null, completedSummary: claim.summary },
        );
      }
      return withNoProgressRule(
        closeIteration(goal, "continued", finished, now, {}),
        madeProgress(current.notesThisIteration, finished.workspaceChanged),
      );
    }
  }
}

function closeIteration(
  goal: OrchestrationV2ThreadGoal,
  outcome: OrchestrationV2GoalIterationOutcome,
  finished: { readonly tokens: number; readonly workspaceChanged: boolean | null },
  now: string,
  overrides: Partial<OrchestrationV2ThreadGoal>,
): OrchestrationV2ThreadGoal {
  const current = goal.current!;
  const record: OrchestrationV2GoalIterationRecord = {
    iteration: current.iteration,
    childThreadId: current.childThreadId,
    outcome,
    tokens: finished.tokens,
    workspaceChanged: finished.workspaceChanged,
    finishedAt: now,
  };
  const undelivered = (current.pendingMessages ?? []).map((message) => message.text);
  const next: OrchestrationV2ThreadGoal = {
    ...goal,
    resumeNote:
      undelivered.length === 0
        ? (goal.resumeNote ?? null)
        : withResumeNote(goal, undelivered.join("\n\n"), null, now),
    current: null,
    history: [...goal.history, record].slice(-MAX_GOAL_HISTORY),
    ...overrides,
  };
  if (next.status === "active" && next.iteration >= next.safetyCap) {
    return { ...next, status: "paused", statusReason: "safety_cap" };
  }
  return next;
}

function withNoProgressRule(
  goal: OrchestrationV2ThreadGoal,
  progressed: boolean,
): OrchestrationV2ThreadGoal {
  const consecutiveNoProgress = progressed ? 0 : goal.consecutiveNoProgress + 1;
  if (goal.status === "active" && consecutiveNoProgress >= goal.noProgressLimit) {
    return { ...goal, consecutiveNoProgress, status: "paused", statusReason: "no_progress" };
  }
  return { ...goal, consecutiveNoProgress };
}

function madeProgress(notes: number, workspaceChanged: boolean | null): boolean {
  return notes > 0 || workspaceChanged === true;
}

const ACCOUNTING_RANK: Record<OrchestrationV2GoalUsageAccounting, number> = {
  exact: 0,
  estimated: 1,
  unavailable: 2,
};

function worseAccounting(
  left: OrchestrationV2GoalUsageAccounting,
  right: OrchestrationV2GoalUsageAccounting,
): OrchestrationV2GoalUsageAccounting {
  return ACCOUNTING_RANK[left] >= ACCOUNTING_RANK[right] ? left : right;
}

/** Appends a note and drops the oldest ones once the total exceeds the cap. */
function appendNote(
  notes: ReadonlyArray<OrchestrationV2GoalProgressNote>,
  note: OrchestrationV2GoalProgressNote,
): ReadonlyArray<OrchestrationV2GoalProgressNote> {
  const kept = [...notes, note];
  let total = kept.reduce((sum, entry) => sum + entry.text.length, 0);
  while (kept.length > 1 && total > MAX_GOAL_NOTES_TOTAL_CHARS) {
    total -= kept.shift()!.text.length;
  }
  return kept;
}

export function goalSummary(
  goal: OrchestrationV2ThreadGoal | null | undefined,
): OrchestrationV2ThreadGoalSummary | null {
  if (goal == null) return null;
  return {
    id: goal.id,
    objective:
      goal.objective.length > SHELL_OBJECTIVE_CHARS
        ? `${goal.objective.slice(0, SHELL_OBJECTIVE_CHARS - 1)}…`
        : goal.objective,
    status: goal.status,
    statusReason: goal.statusReason,
    iteration: goal.iteration,
    tokensUsed: goal.tokensUsed,
    needsInput: goal.current?.waitingOnRequest != null,
    currentChildThreadId: goal.current?.childThreadId ?? null,
    updatedAt: goal.updatedAt,
    summaryNote:
      goal.completedSummary == null
        ? null
        : goal.completedSummary.length > SHELL_SUMMARY_CHARS
          ? `${goal.completedSummary.slice(0, SHELL_SUMMARY_CHARS - 1)}…`
          : goal.completedSummary,
  };
}
