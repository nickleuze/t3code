import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  t3GoalAttention,
  t3GoalHeadline,
  t3GoalOwnsActivity,
} from "@t3tools/shared/agentAwareness";

import type { SidebarThreadStatus } from "./Sidebar.logic";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

/**
 * Attention notifies at once. Completion waits out the Working shelf's exit grace,
 * because an orchestrator run can end moments before its continuation starts. Any
 * observation that is not settled during the wait cancels it.
 */
export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  const pending = new Map<Key, { at: number; timer: ReturnType<typeof setTimeout> }>();
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // The newest completion seen settled, kept while the thread works or waits.
  const lastSettled = new Map<Key, number>();
  const cancel = (key: Key) => {
    clearTimeout(pending.get(key)?.timer);
    pending.delete(key);
  };
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: { readonly archived: boolean; readonly quiet: boolean },
    ): void {
      if (next.settled && next.completedAt !== null) lastSettled.set(key, next.completedAt);
      if (!next.settled || options.archived || options.quiet) cancel(key);
      // The first sighting, archived threads, and stopped or silent runs never notify completion.
      if (!prior || options.archived || options.quiet) skip(key, next.completedAt);
      if (!prior || options.archived) return;
      if (next.attention && next.attention !== prior.attention) {
        // Attention replaces the completion before it, so that run must not notify later.
        skip(key, lastSettled.get(key) ?? null);
        cancel(key);
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      if (pending.get(key)?.at === at) return;
      cancel(key);
      pending.set(key, {
        at,
        timer: setTimeout(() => {
          pending.delete(key);
          handled.set(key, at);
          notify(key, "completion");
        }, WORKING_EXIT_GRACE_MS),
      });
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of pending.keys()) if (!keys.has(key)) cancel(key);
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of lastSettled.keys()) if (!keys.has(key)) lastSettled.delete(key);
    },
    clear(): void {
      for (const key of pending.keys()) cancel(key);
      handled.clear();
      lastSettled.clear();
    },
  };
}

type GoalNotificationThread = Pick<OrchestrationV2ThreadShell, "t3Goal" | "latestRunRequestedAt">;

export interface ThreadGoalNotification {
  /** The status to notify on, with the owner's goal speaking for its runs. */
  readonly status: SidebarThreadStatus;
  /** Part of the attention key, so each goal state change notifies once. */
  readonly attentionKey: string;
  /** Run completions stay quiet while the goal owns the thread's activity. */
  readonly holdsRunCompletion: boolean;
  /** The goal id once it completed; a change to it is a "Goal complete" notification. */
  readonly completedGoalId: string | null;
  /** Headline for goal attention, or null when the run's own title applies. */
  readonly attentionTitle: string | null;
}

/**
 * How a goal owner's thread notifies. Approvals and questions on the owner keep
 * their own status; otherwise the goal's attention replaces the run's.
 */
export function resolveThreadGoalNotification(
  raw: GoalNotificationThread,
  thread: { readonly hasPendingApprovals: boolean; readonly hasPendingUserInput: boolean },
  runStatus: SidebarThreadStatus,
): ThreadGoalNotification {
  const goal = raw.t3Goal ?? null;
  const holdsRunCompletion = t3GoalOwnsActivity(raw);
  let status = runStatus;
  if (
    goal !== null &&
    holdsRunCompletion &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput
  ) {
    const goalAttention = t3GoalAttention(goal);
    status =
      goalAttention === "input" || goalAttention === "limited" || goalAttention === "working"
        ? goalAttention
        : "ready";
  }
  return {
    status,
    attentionKey:
      goal === null
        ? ""
        : `${goal.id}:${goal.status}:${goal.statusReason ?? ""}:${goal.needsInput}`,
    holdsRunCompletion,
    completedGoalId: goal?.status === "complete" ? goal.id : null,
    attentionTitle:
      goal === null || status !== "input" || thread.hasPendingUserInput
        ? null
        : t3GoalHeadline(goal),
  };
}
