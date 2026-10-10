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
      : goal.needsInput
        ? "Goal needs input"
        : goal.status === "blocked"
          ? "Goal blocked"
          : goal.status === "paused"
            ? "Goal paused"
            : goal.status === "usageLimited"
              ? "Usage limit reached"
              : goal.status === "complete"
                ? "Goal complete"
                : "Goal is working";
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
    if (goal.needsInput || goal.status === "blocked" || goal.status === "usageLimited") {
      return "waiting_for_input";
    }
    if (goal.status === "paused") {
      return goal.statusReason === "user" ? null : "waiting_for_input";
    }
    return goal.status === "complete" ? "completed" : "running";
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
