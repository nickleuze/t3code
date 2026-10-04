import type { OrchestrationV2ThreadGoalSummary, ThreadId } from "@t3tools/contracts";
import { TargetIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
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

/** Composer banner for a thread's `/goal` loop, with the controls that apply to its state. */
export function goalBannerItem(props: GoalBannerProps): ComposerBannerStackItem {
  const { goal } = props;
  const ended = goal.status === "complete" || goal.status === "stopped";
  return {
    id: `goal:${goal.id}`,
    variant: goal.status === "complete" ? "success" : goalNeedsAttention(goal) ? "warning" : "info",
    priority: goalNeedsAttention(goal) ? "urgent" : goalIsRunning(goal) ? "activity" : "notice",
    icon: <TargetIcon />,
    title: goalStatusLabel(goal),
    description:
      goal.iteration > 0
        ? `${goal.objective} · ${formatGoalTokens(goal.tokensUsed)}`
        : goal.objective,
    actions: <GoalBannerActions key={`${goal.id}:${goal.status}`} {...props} />,
    ...(ended
      ? { dismissLabel: "Clear goal", onDismiss: () => void props.onControl("clear") }
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
