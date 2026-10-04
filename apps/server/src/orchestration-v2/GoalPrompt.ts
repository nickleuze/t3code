import type { OrchestrationV2ThreadGoal } from "@t3tools/contracts";

/**
 * The opening message of goal iteration `iteration`. Each iteration starts
 * in a fresh thread, so this message is the only context it inherits.
 */
export function buildGoalIterationPrompt(
  goal: OrchestrationV2ThreadGoal,
  iteration: number,
): string {
  const sections = [
    `You are running iteration ${iteration} of a long-running goal in T3 Code. You start with a fresh context: earlier iterations' conversations are not visible, only the notes below. The workspace already contains their changes.`,
    `## Goal\n\n${goal.objective}`,
    goal.progressNotes.length === 0
      ? "## Progress so far\n\nNone yet. This is the first iteration."
      : `## Progress notes from earlier iterations\n\n${goal.progressNotes
          .map((note) => `- [iteration ${note.iteration}] ${note.text}`)
          .join("\n")}`,
  ];
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
      "- Make concrete progress toward the goal, then end your turn. The next iteration continues from your notes.",
      "- Before you finish, call `t3_goal_update` with a short note: what you did, what you learned, and what should happen next.",
      `- When the whole goal is achieved, call \`t3_goal_complete\` with status "complete" and a summary.${completion}`,
      '- If you cannot continue without the user (missing access, or a decision only they can make), call `t3_goal_complete` with status "blocked" and say what you need.',
      "- Avoid asking the user questions mid-iteration; nobody may be watching.",
    ].join("\n"),
  );
  return sections.join("\n\n");
}
