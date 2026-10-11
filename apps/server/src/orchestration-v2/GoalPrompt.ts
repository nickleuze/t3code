import { goalIterationTimeoutMins, type OrchestrationV2ThreadGoal } from "@t3tools/contracts";

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
      ? `## Handoff file\n\nRead \`${goal.handoffPath}\` first: it holds the current state earlier iterations left. Checks it records as passing are verified; do not re-run them unless you changed what they cover or something shows they no longer hold. These instructions take precedence over any rule in the handoff that asks you to re-check.`
      : "## Handoff file\n\nThere is no handoff file yet. Create one in the workspace (for example `docs/agent-work/<short-goal-name>/HANDOFF.md`) and pass its path to `t3_goal_update` as `handoffPath`.",
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
      `- Keep working through the goal, step after step, for the whole iteration; do not end your turn after one step to leave the rest to a later iteration. You have about ${goalIterationTimeoutMins(goal)} minutes, and T3 Code tells you when to wrap up. If your turn ends while this thread still has context to spare, T3 Code asks you to continue here.`,
      "- Keep the handoff file a current-state document for a fresh agent: current state, decisions, what is verified (and by which command), and next steps. Rewrite it each time instead of appending, keep it under about 15 KB, and keep its change log to at most 10 dated lines.",
      "- Do not save command output, logs or other evidence files per step unless the goal asks for them. Record each result as one line in the handoff.",
      "- Before your turn ends, rewrite the handoff and call `t3_goal_update` with one or two sentences on what changed. Details belong in the handoff file, not the note.",
      `- As soon as the goal is achieved${goal.doneWhen ? ' and the "Done when" conditions hold' : ""}, call \`t3_goal_complete\` with status "complete" and a summary. Do not add checks, reviews or approvals the goal does not ask for.${completion}`,
      '- If you need a decision or approval from the user, ask with your question tool (or `t3_ask_user_question`) and wait for the answer; the user is notified. Use `t3_goal_complete` with status "blocked" only when work cannot continue for a long time, and say what you need.',
    ].join("\n"),
  );
  return sections.join("\n\n");
}
