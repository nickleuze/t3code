import type {
  OrchestrationV2GoalIterationMarker,
  OrchestrationV2GoalProposal,
  OrchestrationV2ThreadGoalSummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  goalControlActions,
  goalIsRunning,
  goalNeedsAttention,
  presentT3Goal,
  type GoalControlAction,
} from "@t3tools/client-runtime/state/thread-goals";
import { TargetIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const CONTROL_LABELS: Record<Exclude<GoalControlAction, "clear">, [string, string]> = {
  resume: ["Resume", "Resuming..."],
  pause: ["Pause", "Pausing..."],
  stop: ["Stop", "Stopping..."],
};

function toastFailure(title: string) {
  return (cause: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: cause instanceof Error ? cause.message : String(cause),
      }),
    );
}

interface GoalBannerProps {
  readonly goal: OrchestrationV2ThreadGoalSummary;
  readonly canControl: boolean;
  readonly onControl: (action: GoalControlAction) => Promise<void>;
  readonly onOpenIteration: (childThreadId: ThreadId) => void;
  /** Offered while the goal is paused or blocked with no iteration running. */
  readonly onEdit: (() => void) | null;
}

/** Composer banner for a thread's `/t3-goal` loop, laid out like the native `/goal` row. */
export function goalBannerItem(props: GoalBannerProps): ComposerBannerStackItem {
  const { goal } = props;
  const presentation = presentT3Goal(goal);
  const attention = goalNeedsAttention(goal);
  return {
    id: `t3-goal:${goal.id}`,
    variant: goal.status === "complete" ? "success" : attention ? "warning" : "info",
    priority: attention ? "urgent" : goalIsRunning(goal) ? "activity" : "notice",
    icon: <TargetIcon />,
    // Usage stays in the title so a long objective cannot clip it.
    title:
      presentation.usage === null
        ? presentation.title
        : `${presentation.title} · ${presentation.usage}`,
    description: presentation.objective,
    actions: <GoalBannerActions key={`${goal.id}:${goal.status}`} {...props} />,
    ...(goalControlActions(goal).includes("clear") && props.canControl
      ? {
          dismissLabel: "Clear goal",
          onDismiss: () =>
            void props.onControl("clear").catch(toastFailure("Could not clear the goal")),
        }
      : {}),
  };
}

function GoalBannerActions({
  goal,
  canControl,
  onControl,
  onOpenIteration,
  onEdit,
}: GoalBannerProps) {
  const [pending, setPending] = useState<GoalControlAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: GoalControlAction) => {
    if (!canControl || pending !== null) return;
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      {child !== null ? (
        <Button size="xs" variant="ghost" onClick={() => onOpenIteration(child)}>
          {goal.needsInput ? "Answer" : "Open iteration"}
        </Button>
      ) : null}
      {onEdit !== null ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={!canControl || pending !== null}
          onClick={onEdit}
        >
          Edit
        </Button>
      ) : null}
      {goalControlActions(goal).map((action) =>
        action === "clear" ? null : (
          <Button
            key={action}
            size="xs"
            variant="ghost"
            disabled={!canControl || pending !== null}
            onClick={() => void run(action)}
          >
            {CONTROL_LABELS[action][pending === action ? 1 : 0]}
          </Button>
        ),
      )}
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
  readonly canStart: boolean;
  readonly canDismiss: boolean;
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
    ...(props.canDismiss
      ? {
          dismissLabel: "Dismiss proposed goal",
          onDismiss: () =>
            void props.onDismiss().catch(toastFailure("Could not dismiss the proposed goal")),
        }
      : {}),
  };
}

function GoalProposalActions({ canStart, onStart, onEdit }: GoalProposalBannerProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const starting = useRef(false);
  const start = async () => {
    if (!canStart || starting.current) return;
    starting.current = true;
    setPending(true);
    setError(null);
    try {
      await onStart();
    } catch (cause) {
      starting.current = false;
      setError(cause instanceof Error ? cause.message : "Could not start the goal.");
      setPending(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" disabled={!canStart || pending} onClick={() => void start()}>
        {pending ? "Starting..." : "Start goal"}
      </Button>
      <Button size="xs" variant="ghost" disabled={!canStart || pending} onClick={onEdit}>
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

/** Inline note on an iteration thread pointing back to its goal thread. */
export function goalIterationBannerItem(
  marker: OrchestrationV2GoalIterationMarker,
  onOpenGoal: (threadId: ThreadId) => void,
): ComposerBannerStackItem {
  return {
    id: `t3-goal-iteration:${marker.goalId}:${marker.iteration}`,
    variant: "info",
    priority: "notice",
    icon: <TargetIcon />,
    title: `Goal iteration ${marker.iteration}`,
    description: "Progress in this iteration goes to the goal thread.",
    actions: (
      <Button size="xs" variant="ghost" onClick={() => onOpenGoal(marker.parentThreadId)}>
        Open goal
      </Button>
    ),
  };
}
