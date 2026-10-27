import type {
  OrchestrationV2GoalIterationMarker,
  OrchestrationV2GoalProposal,
  OrchestrationV2ThreadGoalSummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  goalControlActions,
  goalNeedsAttention,
  presentT3Goal,
  type GoalControlAction,
} from "@t3tools/client-runtime/state/thread-goals";
import { TargetIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button, InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ThreadNowItem } from "./ThreadNow";

const CONTROL_LABELS: Record<GoalControlAction, [string, string]> = {
  clear: ["Clear", "Clearing..."],
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

/** A thread's `/t3-goal` loop at the end of the timeline, where the native `/goal` line sits. */
export function goalNowItem(props: GoalBannerProps): ThreadNowItem {
  const { goal } = props;
  const presentation = presentT3Goal(goal);
  return {
    id: `t3-goal:${goal.id}`,
    icon: <TargetIcon className={goalNeedsAttention(goal) ? "text-info-foreground" : undefined} />,
    // Usage stays in the title so a long objective cannot clip it.
    title:
      presentation.usage === null
        ? presentation.title
        : `${presentation.title} · ${presentation.usage}`,
    description: presentation.objective,
    actions: <GoalNowActions key={`${goal.id}:${goal.status}`} {...props} />,
  };
}

function GoalNowActions({ goal, canControl, onControl, onOpenIteration, onEdit }: GoalBannerProps) {
  const [pending, setPending] = useState<GoalControlAction | null>(null);
  const run = async (action: GoalControlAction) => {
    if (!canControl || pending !== null) return;
    setPending(action);
    await onControl(action).catch(toastFailure("Could not update the goal"));
    setPending(null);
  };
  const child = goal.currentChildThreadId;
  return (
    <>
      {child !== null ? (
        <InlineButton onClick={() => onOpenIteration(child)}>
          {goal.needsInput ? "Answer" : "Open iteration"}
        </InlineButton>
      ) : null}
      {onEdit !== null ? (
        <InlineButton disabled={!canControl || pending !== null} onClick={onEdit}>
          Edit
        </InlineButton>
      ) : null}
      {goalControlActions(goal).map((action) => (
        <InlineButton
          key={action}
          disabled={!canControl || pending !== null}
          onClick={() => void run(action)}
        >
          {CONTROL_LABELS[action][pending === action ? 1 : 0]}
        </InlineButton>
      ))}
    </>
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
    icon: <TargetIcon />,
    title: `Proposed goal: ${proposal.objective}`,
    description: [
      `Done when: ${proposal.doneWhen}`,
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
