import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../../state/server";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2GoalIterationOutcome,
  OrchestrationV2ThreadGoal,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useThreadProjection } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatGoalTokens, goalStatusLabel, goalSummaryFromGoal } from "./goalPresentation";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "./threadDetailsPanelStyles";

const OUTCOME_LABELS: Record<OrchestrationV2GoalIterationOutcome, string> = {
  continued: "Continued",
  claimed_complete: "Completed",
  check_failed: "Check failed",
  blocked: "Blocked",
  failed: "Failed",
  interrupted: "Interrupted",
  usage_limited: "Usage limit",
  timed_out: "Out of time",
};

const NOTES_SHOWN = 5;

/**
 * Thread details section for the thread's `/t3-goal` loop: what it is working
 * toward, where it stands, recent progress notes, and each iteration's thread.
 */
export function ThreadGoalPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projection = useThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const navigate = useNavigate();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const goal =
    config?.environment.capabilities.t3Goals === true
      ? (projection?.projection.thread.goal ?? null)
      : null;
  if (goal === null) return null;

  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });

  return (
    <ThreadDetailsSection
      headingId="thread-details-goal-heading"
      title="T3 goal"
      data-thread-goal-panel
    >
      <div className={cn("flex flex-col gap-2 py-1", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}>
        <p className="text-sm text-foreground/80">{goal.objective}</p>
        <p className="text-2xs text-muted-foreground">{goalFacts(goal)}</p>
        {goal.completedSummary ? (
          <p className="text-xs text-foreground/70">{goal.completedSummary}</p>
        ) : null}
        {goal.doneWhen ? <GoalFact label="Done when">{goal.doneWhen}</GoalFact> : null}
        {goal.permissions ? <GoalFact label="Pre-approved">{goal.permissions}</GoalFact> : null}
        {goal.handoffPath ? (
          <GoalFact label="Handoff">
            <code>{goal.handoffPath}</code>
          </GoalFact>
        ) : null}
        {goal.resumeNote?.userMessage || goal.current?.pendingMessages?.length ? (
          <GoalFact label="Your message">
            {goal.current?.pendingMessages?.length
              ? "Delivering to the running iteration"
              : "Waiting for the next iteration"}
          </GoalFact>
        ) : null}
        {goal.lastCheck ? (
          <details className="text-2xs text-muted-foreground">
            <summary className="cursor-pointer">
              <code>{goal.lastCheck.command}</code>{" "}
              {goal.lastCheck.passed ? "passed" : goal.lastCheck.timedOut ? "timed out" : "failed"}{" "}
              after iteration {goal.lastCheck.iteration}
            </summary>
            {goal.lastCheck.outputTail ? (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">
                {goal.lastCheck.outputTail}
              </pre>
            ) : null}
          </details>
        ) : null}
        {goal.progressNotes.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {goal.progressNotes.slice(-NOTES_SHOWN).map((note) => (
              <li key={`${note.iteration}:${note.at}`} className="text-xs text-foreground/70">
                <span className="text-muted-foreground">#{note.iteration}</span> {note.text}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {goal.current !== null || goal.history.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {goal.current !== null ? (
            <IterationRow
              label={`Iteration ${goal.current.iteration}`}
              detail={goal.current.phase === "checking" ? "Running check" : "Running"}
              onOpen={() => openThread(goal.current!.childThreadId)}
            />
          ) : null}
          {goal.history.toReversed().map((record) => (
            <IterationRow
              key={record.iteration}
              label={`Iteration ${record.iteration}`}
              detail={`${OUTCOME_LABELS[record.outcome]} · ${formatGoalTokens(record.tokens)}`}
              onOpen={() => openThread(record.childThreadId)}
            />
          ))}
        </ul>
      ) : null}
    </ThreadDetailsSection>
  );
}

function goalFacts(goal: OrchestrationV2ThreadGoal): string {
  const tokens =
    goal.usageAccounting === "unavailable"
      ? "token usage not reported"
      : `${goal.usageAccounting === "estimated" ? "~" : ""}${formatGoalTokens(goal.tokensUsed)}`;
  return [
    goalStatusLabel(goalSummaryFromGoal(goal)),
    goal.iteration === 1 ? "1 iteration" : `${goal.iteration} iterations`,
    tokens,
    goal.burnGuard
      ? `burn guard ${goal.burnGuard.maxPercentPoints}% / ${goal.burnGuard.windowMins}m`
      : "no burn guard",
    `${goal.iterationTimeoutMins ?? 120} min per iteration`,
  ].join(" · ");
}

function GoalFact(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <p className="text-xs text-foreground/70">
      <span className="text-muted-foreground">{props.label}: </span>
      {props.children}
    </p>
  );
}

function IterationRow(props: {
  readonly label: string;
  readonly detail: string;
  readonly onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full items-baseline justify-between gap-2 rounded-lg py-1 text-left hover:bg-accent/50",
          THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
        )}
        onClick={props.onOpen}
      >
        <span className="text-sm text-foreground/80">{props.label}</span>
        <span className="truncate text-2xs text-muted-foreground">{props.detail}</span>
      </button>
    </li>
  );
}
