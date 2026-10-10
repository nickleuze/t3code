import type {
  CommandId,
  OrchestrationV2GoalIterationMarker,
  OrchestrationV2GoalIterationOutcome,
  OrchestrationV2ThreadGoal,
  OrchestrationV2ThreadGoalSummary,
} from "@t3tools/contracts";
import { t3GoalAttention } from "@t3tools/shared/agentAwareness";

import {
  formatGoalTokens as formatTokenCount,
  type ProviderGoalPresentation,
} from "./threadExecution.ts";

export type GoalControlAction = "pause" | "resume" | "stop" | "clear";

export function goalControlActions(goal: OrchestrationV2ThreadGoalSummary) {
  const actions: Array<GoalControlAction> = [];
  if (goal.status === "active") actions.push("pause");
  if (["paused", "blocked", "usageLimited"].includes(goal.status)) actions.push("resume");
  if (goalIsLive(goal)) actions.push("stop");
  // A stopped goal's last iteration may still be winding down; it can only be
  // cleared once that child is done.
  if (!goalIsLive(goal) && goal.currentChildThreadId === null) actions.push("clear");
  return actions;
}

/** Classifies composer sends before they can enter the ordinary-turn path. */
export function resolveGoalComposerIntent(input: {
  readonly text: string;
  readonly goal: OrchestrationV2ThreadGoalSummary | null;
  readonly supportsGoals: boolean;
  readonly canMutate: boolean;
  readonly isIteration: boolean;
  readonly isSubagent: boolean;
  readonly hasNonTextContent: boolean;
}):
  | { readonly kind: "ordinary"; readonly text: string }
  | { readonly kind: "reply"; readonly goalId: CommandId; readonly text: string }
  | { readonly kind: "blocked"; readonly reason: string } {
  if (input.goal !== null && goalIsLive(input.goal)) {
    if (!input.supportsGoals || !input.canMutate)
      return { kind: "blocked", reason: "This connection cannot control T3 goals." };
    if (input.hasNonTextContent)
      return {
        kind: "blocked",
        reason:
          "Goal replies support text only. Open the iteration to send attachments or context.",
      };
    if (input.text.trim().length === 0)
      return { kind: "blocked", reason: "Write a message for the goal." };
    return { kind: "reply", goalId: input.goal.id, text: input.text.trim() };
  }
  const command = parseComposerGoalCommand(input.text);
  if (command === null) return { kind: "ordinary", text: input.text };
  if (!input.supportsGoals || !input.canMutate || input.isIteration || input.isSubagent)
    return { kind: "blocked", reason: "T3 goals are unavailable in this thread." };
  if (input.hasNonTextContent)
    return { kind: "blocked", reason: "Send /t3-goal as text alone to draft a goal." };
  return { kind: "ordinary", text: goalDraftRequestMessage(command.objective) };
}

/** `/t3-goal` alone or followed by an objective; the objective is null for a bare `/t3-goal`. */
export function parseComposerGoalCommand(
  text: string,
): { readonly objective: string | null } | null {
  const match = /^\/t3-goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const objective = match[1]?.trim() ?? "";
  return { objective: objective.length > 0 ? objective : null };
}

/**
 * What `/t3-goal` sends to the thread's agent, which drafts the goal with
 * `t3_goal_propose` for the user to start. It must not start with "/", or
 * providers would read it as one of their own commands.
 */
export function goalDraftRequestMessage(objective: string | null): string {
  const instruction =
    "Draft it with the t3_goal_propose tool, inferring the finish line, background and any check command from our conversation and the workspace.";
  return objective === null
    ? `Make the current task a T3 goal. ${instruction}`
    : `Make this a T3 goal: ${objective}\n\n${instruction}`;
}

const PAUSE_REASONS: Record<
  NonNullable<OrchestrationV2ThreadGoalSummary["statusReason"]>,
  (iteration: number) => string
> = {
  user: () => "Goal paused",
  agent: () => "Goal paused",
  no_progress: () => "Paused: recent iterations made no progress",
  burn_rate: () => "Paused: provider usage climbed too fast",
  child_failed: (iteration) => `Paused: iteration ${iteration} failed`,
  child_interrupted: (iteration) => `Paused: iteration ${iteration} was interrupted`,
  check_error: () => "Paused: the check command could not run",
  safety_cap: () => "Paused at the iteration safety cap",
  iteration_timeout: (iteration) => `Paused: iteration ${iteration} ran too long`,
  parent_unavailable: () => "Goal stopped",
};

export function goalStatusLabel(goal: OrchestrationV2ThreadGoalSummary): string {
  switch (goal.status) {
    case "active":
      if (goal.needsInput) return `Iteration ${goal.iteration} needs your input`;
      return goal.iteration === 0 ? "Starting goal" : `Working on iteration ${goal.iteration}`;
    case "paused":
      return PAUSE_REASONS[goal.statusReason ?? "user"](goal.iteration);
    case "blocked":
      return "Blocked: the agent needs you";
    case "usageLimited":
      return "Waiting for the usage limit to reset";
    case "complete":
      return "Goal complete";
    case "stopped":
      return "Goal stopped";
  }
}

/** A goal waiting on the user: a question in its iteration, or a stop only they can lift. */
export function goalNeedsAttention(goal: OrchestrationV2ThreadGoalSummary): boolean {
  return t3GoalAttention(goal) === "input";
}

/** A goal that has not ended; its thread's composer messages the goal. */
export function goalIsLive(goal: OrchestrationV2ThreadGoalSummary): boolean {
  return goal.status !== "complete" && goal.status !== "stopped";
}

/** A goal that can be edited: live, with no iteration running. */
export function goalIsEditable(goal: OrchestrationV2ThreadGoalSummary): boolean {
  return (
    (goal.status === "paused" || goal.status === "blocked") && goal.currentChildThreadId === null
  );
}

/** Where a message typed in a goal thread will go. */
export function goalComposerPlaceholder(goal: OrchestrationV2ThreadGoalSummary): string {
  if (goal.status === "paused" || goal.status === "blocked") {
    return "Reply to resume the goal; the next iteration gets your message";
  }
  if (goal.status === "active" && goal.currentChildThreadId !== null) {
    return "Message the running goal iteration";
  }
  return "Leave a message for the next goal iteration";
}

/**
 * Working-shelf membership: a goal at work makes its thread working, and a
 * goal waiting on the user keeps it in the inbox despite the thread's own work.
 */
export function goalAwareThreadWorking(
  goal: OrchestrationV2ThreadGoalSummary | null | undefined,
  threadWorking: boolean,
): boolean {
  const attention = goal == null ? null : t3GoalAttention(goal);
  return attention === "working" || (threadWorking && attention !== "input");
}

export function goalIsRunning(goal: OrchestrationV2ThreadGoalSummary): boolean {
  return goal.status === "active" || goal.status === "usageLimited";
}

/** Same units as the native `/goal` row: "950 tokens", "12k tokens", "2.4m tokens". */
export function formatGoalTokens(tokens: number): string {
  return `${formatTokenCount(tokens)} tokens`;
}

/**
 * Status line for a T3 goal, in the native `/goal` row's shape so both render
 * alike. A blocked or finished goal leads with what the agent said.
 */
export function presentT3Goal(goal: OrchestrationV2ThreadGoalSummary): ProviderGoalPresentation {
  return {
    title: goalStatusLabel(goal),
    objective:
      (goal.status === "blocked" || goal.status === "complete") && goal.summaryNote
        ? goal.summaryNote
        : goal.objective,
    usage: goal.iteration > 0 && goal.tokensUsed > 0 ? formatGoalTokens(goal.tokensUsed) : null,
    canResume: goalControlActions(goal).includes("resume"),
  };
}

export const GOAL_ITERATION_OUTCOME_LABELS: Record<OrchestrationV2GoalIterationOutcome, string> = {
  continued: "Continued",
  claimed_complete: "Completed",
  check_failed: "Check failed",
  blocked: "Blocked",
  failed: "Failed",
  interrupted: "Interrupted",
  usage_limited: "Usage limit",
  timed_out: "Out of time",
};

/** Token usage of a full goal, marking estimates and missing reports. */
export function formatGoalUsage(
  goal: Pick<OrchestrationV2ThreadGoal, "usageAccounting" | "tokensUsed">,
): string {
  if (goal.usageAccounting === "unavailable") return "token usage not reported";
  return `${goal.usageAccounting === "estimated" ? "~" : ""}${formatGoalTokens(goal.tokensUsed)}`;
}

/** The shell-sized view of a full goal, so both render the same status text. */
export function goalSummaryFromGoal(
  goal: OrchestrationV2ThreadGoal,
): OrchestrationV2ThreadGoalSummary {
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    statusReason: goal.statusReason,
    iteration: goal.iteration,
    tokensUsed: goal.tokensUsed,
    needsInput: goal.current?.waitingOnRequest != null,
    currentChildThreadId: goal.current?.childThreadId ?? null,
  };
}

/**
 * Short thread-row status for a goal thread; null keeps the row's usual label.
 * `status` is the row's resolved status ("input", "working", ...).
 */
export function goalRowStatusLabel(
  goal: OrchestrationV2ThreadGoalSummary | null | undefined,
  status: string,
): string | null {
  if (goal == null || !goalIsLive(goal)) return null;
  if (status === "input") {
    return goal.needsInput ? "Input" : goal.status === "blocked" ? "Blocked" : "Paused";
  }
  if (status === "working" && goal.status === "active") {
    return goal.iteration === 0 ? "Goal" : `Iteration ${goal.iteration}`;
  }
  return null;
}

// Goal threads in thread lists. Iteration threads nest under their goal
// thread instead of listing at the top level. Keys are `${environmentId}:${id}`.

interface GoalListThread {
  readonly id: string;
  readonly environmentId: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly lineage: { readonly relationshipToParent: string | null };
  readonly goalIteration?: OrchestrationV2GoalIterationMarker | null;
}

const threadKey = (thread: Pick<GoalListThread, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

const isListable = (thread: GoalListThread) =>
  thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent";

/**
 * Splits listable threads (not archived, not subagents) into top-level rows
 * and the iterations nested under a listed goal thread, newest first. An
 * iteration whose goal thread is not listed stays top-level.
 */
export function nestGoalIterations<T extends GoalListThread>(
  threads: readonly T[],
): { readonly roots: T[]; readonly iterations: ReadonlyMap<string, readonly T[]> } {
  const listed = threads.filter(isListable);
  const owners = new Set(listed.filter((thread) => thread.goalIteration == null).map(threadKey));
  const roots: T[] = [];
  const iterations = new Map<string, T[]>();
  for (const thread of listed) {
    const marker = thread.goalIteration;
    const ownerKey = marker == null ? null : `${thread.environmentId}:${marker.parentThreadId}`;
    if (ownerKey === null || !owners.has(ownerKey)) {
      roots.push(thread);
      continue;
    }
    const group = iterations.get(ownerKey);
    if (group) group.push(thread);
    else iterations.set(ownerKey, [thread]);
  }
  for (const group of iterations.values())
    group.sort(
      (left, right) =>
        (right.goalIteration?.iteration ?? 0) - (left.goalIteration?.iteration ?? 0) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
  return { roots, iterations };
}

/** The goal thread a selected iteration nests under, so lists keep it in view; otherwise `routeKey`. */
export function goalRouteOwnerKey(
  threads: readonly GoalListThread[],
  routeKey: string | null,
): string | null {
  if (routeKey === null) return null;
  const iteration = threads.find((thread) => threadKey(thread) === routeKey);
  if (iteration?.goalIteration == null) return routeKey;
  const ownerKey = `${iteration.environmentId}:${iteration.goalIteration.parentThreadId}`;
  return threads.some(
    (thread) =>
      threadKey(thread) === ownerKey && isListable(thread) && thread.goalIteration == null,
  )
    ? ownerKey
    : routeKey;
}

/**
 * `selectedKey` when it names one of these iterations, else null. Rows pass
 * this instead of the global selection so a selection change re-renders only
 * the rows it touches.
 */
export function selectedGoalIterationKey(
  iterations: readonly Pick<GoalListThread, "environmentId" | "id">[] | undefined,
  selectedKey: string | null | undefined,
): string | null {
  if (selectedKey == null || iterations === undefined) return null;
  return iterations.some((thread) => threadKey(thread) === selectedKey) ? selectedKey : null;
}

const COLLAPSED_GOAL_ITERATIONS = 3;

/**
 * Iterations shown under a goal thread: the running one first, then the
 * newest. Collapsed rows show three, parked (settled) rows only the running
 * one; the selected iteration always stays visible.
 */
export function shownGoalIterations<T extends Pick<GoalListThread, "environmentId" | "id">>(input: {
  readonly iterations: readonly T[];
  readonly currentThreadId: string | null | undefined;
  readonly selectedKey: string | null | undefined;
  readonly expanded: boolean;
  readonly parked: boolean;
  /** Cap while expanded; unlimited by default. */
  readonly expandedLimit?: number;
}): T[] {
  const current = input.iterations.find((thread) => thread.id === input.currentThreadId);
  const ordered = current
    ? [current, ...input.iterations.filter((thread) => thread !== current)]
    : [...input.iterations];
  const limit = input.expanded
    ? (input.expandedLimit ?? ordered.length)
    : input.parked
      ? current
        ? 1
        : 0
      : COLLAPSED_GOAL_ITERATIONS;
  const shown = ordered.slice(0, limit);
  const selected = ordered.find((thread) => threadKey(thread) === input.selectedKey);
  if (selected && !shown.includes(selected)) shown.push(selected);
  return shown;
}

/** "#3 Fixed the parser" from "Goal #3: Fixed the parser" or "Goal iteration 3: …". */
export function goalIterationLabel(thread: {
  readonly title: string;
  readonly goalIteration?: OrchestrationV2GoalIterationMarker | null;
}): string {
  const iteration = thread.goalIteration?.iteration;
  const detail = thread.title.replace(/^Goal (?:#|iteration )\d+:\s*/, "");
  return iteration === undefined ? detail : `#${iteration} ${detail}`;
}
