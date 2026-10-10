import type {
  CommandId,
  OrchestrationV2ThreadGoal,
  OrchestrationV2ThreadGoalSummary,
} from "@t3tools/contracts";

export function goalControlActions(goal: OrchestrationV2ThreadGoalSummary) {
  const actions: Array<"pause" | "resume" | "stop" | "clear"> = [];
  if (goal.status === "active") actions.push("pause");
  if (["paused", "blocked", "usageLimited"].includes(goal.status)) actions.push("resume");
  if (goalIsLive(goal)) actions.push("stop");
  if (!goalIsLive(goal) && goal.currentChildThreadId === null) actions.push("clear");
  return actions;
}

/** Classifies mobile sends before they can enter the ordinary-turn outbox. */
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
