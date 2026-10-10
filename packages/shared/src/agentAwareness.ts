import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export interface ProjectThreadAwarenessV2Input {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<Project, "title">;
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "activityRunStatus"
    | "id"
    | "lineage"
    | "modelSelection"
    | "pendingBackgroundTasks"
    | "pendingRuntimeRequest"
    | "status"
    | "title"
    | "updatedAt"
    | "t3Goal"
    | "goalIteration"
    | "latestRunRequestedAt"
  >;
}

export function t3GoalOwnsActivity(
  thread: Pick<OrchestrationV2ThreadShell, "t3Goal" | "latestRunRequestedAt">,
): boolean {
  const goal = thread.t3Goal;
  return (
    goal != null &&
    goal.status !== "stopped" &&
    (goal.status !== "complete" ||
      goal.updatedAt == null ||
      thread.latestRunRequestedAt == null ||
      DateTime.toEpochMillis(thread.latestRunRequestedAt) <= Date.parse(goal.updatedAt))
  );
}

type T3GoalAttentionInput = Pick<
  NonNullable<OrchestrationV2ThreadShell["t3Goal"]>,
  "status" | "statusReason" | "needsInput"
>;

/**
 * What a T3 goal asks of the user, shared by the sidebar, thread lists,
 * notifications and relay activity. Null once the goal has ended. A pause the
 * user made asks nothing ("paused"); any other pause needs them ("input").
 */
export function t3GoalAttention(
  goal: T3GoalAttentionInput,
): "input" | "limited" | "working" | "paused" | null {
  if (goal.status === "complete" || goal.status === "stopped") return null;
  if (goal.needsInput || goal.status === "blocked") return "input";
  if (goal.status === "paused")
    return (goal.statusReason ?? "user") === "user" ? "paused" : "input";
  return goal.status === "usageLimited" ? "limited" : "working";
}

/** Notification and relay headline for a goal thread. */
export function t3GoalHeadline(goal: T3GoalAttentionInput): string {
  if (goal.needsInput) return "Goal needs input";
  switch (goal.status) {
    case "blocked":
      return "Goal blocked";
    case "paused":
      return "Goal paused";
    case "usageLimited":
      return "Usage limit reached";
    case "complete":
      return "Goal complete";
    case "stopped":
      return "Goal stopped";
    case "active":
      return "Goal is working";
  }
}

/** Build relay activity directly from the V2 shell projection. */
export function projectThreadAwarenessV2(
  input: ProjectThreadAwarenessV2Input,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  // Iterations report through their owner; routine iteration endings stay quiet.
  if (thread.goalIteration != null) return null;
  const phase = resolveThreadAwarenessPhaseV2(thread);
  if (phase === null) {
    return null;
  }
  const goal = thread.t3Goal;
  const goalOwnsActivity = goal != null && t3GoalOwnsActivity(thread);
  const goalHeadline =
    !goalOwnsActivity ||
    (thread.pendingRuntimeRequest !== null && thread.pendingRuntimeRequest.kind !== "auth_refresh")
      ? undefined
      : t3GoalHeadline(goal);
  const detail =
    phase === "completed"
      ? goalOwnsActivity
        ? "Review the completed goal."
        : "Review the completed task."
      : phase === "failed"
        ? "The agent run failed."
        : undefined;
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: goalHeadline ?? headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt:
      goalOwnsActivity && goal.updatedAt != null
        ? goal.updatedAt
        : DateTime.formatIso(thread.updatedAt),
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function resolveThreadAwarenessPhaseV2(
  thread: ProjectThreadAwarenessV2Input["thread"],
): AgentAwarenessPhase | null {
  if (thread.pendingRuntimeRequest?.kind === "user_input") {
    return "waiting_for_input";
  }
  if (
    thread.pendingRuntimeRequest !== null &&
    thread.pendingRuntimeRequest.kind !== "auth_refresh"
  ) {
    return "waiting_for_approval";
  }
  const goal = thread.t3Goal;
  if (goal != null && t3GoalOwnsActivity(thread)) {
    // Relay phases have no usage-limit state; a limited goal waits on the user like input.
    switch (t3GoalAttention(goal)) {
      case "input":
      case "limited":
        return "waiting_for_input";
      case "paused":
        return null;
      case "working":
        return "running";
      case null:
        return "completed";
    }
  }
  switch (thread.activityRunStatus ?? thread.status) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      // Work that will wake the agent keeps the run going; a dev server does not.
      return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
        ? "running"
        : "completed";
    case "failed":
      return "failed";
    case "idle":
    case "queued":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return null;
  }
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
  }
}
