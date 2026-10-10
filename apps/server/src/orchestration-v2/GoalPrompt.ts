import type { OrchestrationV2ThreadGoal } from "@t3tools/contracts";

import { goalIterationTimeoutMins } from "./GoalState.ts";

/**
 * The opening message of goal iteration `iteration`. Each iteration starts
 * in a fresh thread, so this message is the only context it inherits.
 */
export function buildGoalIterationPrompt(
  goal: OrchestrationV2ThreadGoal,
  iteration: number,
): string {
  const sections = [
    `You are running iteration ${iteration} of a long-running goal in T3 Code. You start with a fresh context: earlier iterations' conversations are not visible, only what is below and in the workspace, which already contains their changes. You may delegate work to subagents.`,
    `## Goal\n\n${goal.objective}`,
  ];
  if (goal.doneWhen) sections.push(`## Done when\n\n${goal.doneWhen}`);
  if (goal.background) {
    sections.push(`## Background from the thread that started this goal\n\n${goal.background}`);
  }
  if (goal.permissions) {
    sections.push(
      `## Pre-approved by the user\n\nYou may do these without asking:\n\n${goal.permissions}`,
    );
  }
  const note = goal.resumeNote;
  if (note?.blockedSummary) {
    sections.push(`## Why the previous iteration stopped\n\n${note.blockedSummary}`);
  }
  if (note?.userMessage) {
    sections.push(
      `## Message from the user\n\nThe user wrote this for this iteration; act on it first:\n\n${note.userMessage}`,
    );
  }
  sections.push(
    goal.handoffPath
      ? `## Handoff file\n\nRead \`${goal.handoffPath}\` first: it holds the detailed state earlier iterations left. Treat what it records as verified unless something shows it changed, rather than re-checking it. Update it before you finish.`
      : "## Handoff file\n\nThere is no handoff file yet. Create one in the workspace (for example `docs/agent-work/<short-goal-name>/HANDOFF.md`) with what a fresh iteration needs: current state, decisions, what is verified, and next steps. Pass its path to `t3_goal_update` as `handoffPath`.",
  );
  if (goal.progressNotes.length > 0) {
    sections.push(
      `## Progress notes from earlier iterations\n\n${goal.progressNotes
        .map((entry) => `- [iteration ${entry.iteration}] ${entry.text}`)
        .join("\n")}`,
    );
  }
  const check = goal.lastCheck;
  if (check !== null && !check.passed) {
    const outcome = check.timedOut
      ? "timed out"
      : `failed with exit code ${check.exitCode ?? "unknown"}`;
    sections.push(
      `## Last completion check\n\nAfter iteration ${check.iteration} claimed the goal was done, \`${check.command}\` ${outcome}:\n\n\`\`\`\n${check.outputTail.trim() || "(no output)"}\n\`\`\``,
    );
  }
  const completion =
    goal.checkCommand === null
      ? ""
      : ` T3 Code then runs \`${goal.checkCommand}\`, and the goal only completes if it exits 0.`;
  sections.push(
    [
      "## How to work",
      "",
      `- Make concrete progress toward the goal, then end your turn. You have about ${goalIterationTimeoutMins(goal)} minutes; T3 Code tells you when to wrap up.`,
      "- Before you finish, update the handoff file and call `t3_goal_update` with one or two sentences on what changed. Details belong in the handoff file, not the note.",
      `- When the whole goal is achieved, call \`t3_goal_complete\` with status "complete" and a summary.${completion}`,
      '- If you need a decision or approval from the user, ask with your question tool (or `t3_ask_user_question`) and wait for the answer; the user is notified. Use `t3_goal_complete` with status "blocked" only when work cannot continue for a long time, and say what you need.',
    ].join("\n"),
  );
  return sections.join("\n\n");
}
