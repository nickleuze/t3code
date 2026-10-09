import type {
  OrchestrationV2ThreadGoal,
  OrchestrationV2ThreadGoalSummary,
} from "@t3tools/contracts";

/** `/t3-goal` alone or followed by an objective; the objective is null for a bare `/t3-goal`. */
export function parseComposerGoalCommand(
  text: string,
): { readonly objective: string | null } | null {
  const match = /^\/t3-goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const objective = match[1]?.trim() ?? "";
  return { objective: objective.length > 0 ? objective : null };
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

export function goalNeedsAttention(goal: OrchestrationV2ThreadGoalSummary): boolean {
  return (
    (goal.status === "active" && goal.needsInput) ||
    goal.status === "paused" ||
    goal.status === "blocked"
  );
}

/** A goal that has not ended; its thread's composer messages the goal. */
export function goalIsLive(goal: OrchestrationV2ThreadGoalSummary): boolean {
  return goal.status !== "complete" && goal.status !== "stopped";
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

export function goalIsRunning(goal: OrchestrationV2ThreadGoalSummary): boolean {
  return goal.status === "active" || goal.status === "usageLimited";
}

export function formatGoalTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens} tokens`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
  return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
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
