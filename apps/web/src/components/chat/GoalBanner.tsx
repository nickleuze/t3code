import type {
  OrchestrationV2GoalProposal,
  OrchestrationV2ThreadGoalSummary,
  ThreadId,
} from "@t3tools/contracts";
import { TargetIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  formatGoalTokens,
  goalIsRunning,
  goalNeedsAttention,
  goalStatusLabel,
} from "./goalPresentation";

export type GoalControlAction = "pause" | "resume" | "stop" | "clear";

interface GoalBannerProps {
  readonly goal: OrchestrationV2ThreadGoalSummary;
  readonly onControl: (action: GoalControlAction) => Promise<void>;
  readonly onOpenIteration: (childThreadId: ThreadId) => void;
}

/** Composer banner for a thread's `/t3-goal` loop, with the controls that apply to its state. */
export function goalBannerItem(props: GoalBannerProps): ComposerBannerStackItem {
  const { goal } = props;
  // A stopped goal's last iteration may still be winding down; it can only be
  // cleared once that child is done.
  const clearable =
    (goal.status === "complete" || goal.status === "stopped") && goal.currentChildThreadId === null;
  return {
    id: `goal:${goal.id}`,
    variant: goal.status === "complete" ? "success" : goalNeedsAttention(goal) ? "warning" : "info",
    priority: goalNeedsAttention(goal) ? "urgent" : goalIsRunning(goal) ? "activity" : "notice",
    icon: <TargetIcon />,
    title: goalStatusLabel(goal),
    // A blocked or finished goal leads with what the agent said; otherwise the objective.
    description:
      (goal.status === "blocked" || goal.status === "complete") && goal.summaryNote
        ? goal.summaryNote
        : goal.iteration > 0
          ? `${goal.objective} · ${formatGoalTokens(goal.tokensUsed)}`
          : goal.objective,
    actions: <GoalBannerActions key={`${goal.id}:${goal.status}`} {...props} />,
    ...(clearable
      ? {
          dismissLabel: "Clear goal",
          onDismiss: () =>
            void props.onControl("clear").catch((cause: unknown) =>
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not clear the goal",
                  description: cause instanceof Error ? cause.message : String(cause),
                }),
              ),
            ),
        }
      : {}),
  };
}

function GoalBannerActions({ goal, onControl, onOpenIteration }: GoalBannerProps) {
  const [pending, setPending] = useState<GoalControlAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: GoalControlAction) => {
    setPending(action);
    setError(null);
    try {
      await onControl(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the goal.");
    }
    setPending(null);
  };
  const child = goal.currentChildThreadId;
  const canResume =
    goal.status === "paused" || goal.status === "blocked" || goal.status === "usageLimited";
  const canPause = goal.status === "active" || goal.status === "usageLimited";
  const canStop = canResume || goal.status === "active";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {child !== null ? (
        <Button size="xs" variant="ghost" onClick={() => onOpenIteration(child)}>
          {goal.needsInput ? "Answer" : "Open iteration"}
        </Button>
      ) : null}
      {canResume ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => void run("resume")}
        >
          {pending === "resume" ? "Resuming..." : "Resume"}
        </Button>
      ) : null}
      {canPause && goal.status !== "usageLimited" ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => void run("pause")}
        >
          {pending === "pause" ? "Pausing..." : "Pause"}
        </Button>
      ) : null}
      {canStop ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => void run("stop")}
        >
          {pending === "stop" ? "Stopping..." : "Stop"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface GoalProposalBannerProps {
  readonly proposal: OrchestrationV2GoalProposal;
  readonly onStart: () => Promise<void>;
  readonly onEdit: () => void;
  readonly onDismiss: () => Promise<void>;
}

/** The goal the thread's agent drafted, one click from running. */
export function goalProposalBannerItem(props: GoalProposalBannerProps): ComposerBannerStackItem {
  const { proposal } = props;
  return {
    id: `goal-proposal:${proposal.id}`,
    variant: "info",
    priority: "urgent",
    icon: <TargetIcon />,
    title: `Proposed goal: ${proposal.objective}`,
    description: [
      `Done when: ${proposal.doneWhen}`,
      ...(proposal.checkCommand ? [`Check: ${proposal.checkCommand}`] : []),
      ...(proposal.reason ? [proposal.reason] : []),
    ].join(" · "),
    actions: <GoalProposalActions key={proposal.id} {...props} />,
    dismissLabel: "Dismiss proposed goal",
    onDismiss: () =>
      void props.onDismiss().catch((cause: unknown) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not dismiss the proposed goal",
            description: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      ),
  };
}

function GoalProposalActions({ onStart, onEdit }: GoalProposalBannerProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setPending(true);
    setError(null);
    try {
      await onStart();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the goal.");
      setPending(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" disabled={pending} onClick={() => void start()}>
        {pending ? "Starting..." : "Start goal"}
      </Button>
      <Button size="xs" variant="ghost" disabled={pending} onClick={onEdit}>
        Edit
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
