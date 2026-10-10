import type { OrchestrationV2ThreadGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildGoalIterationPrompt } from "./GoalPrompt.ts";

describe("iteration prompt", () => {
  const goal = {
    objective: "Ship the importer",
    checkCommand: "pnpm test",
    progressNotes: [{ iteration: 1, text: "Parser done; writer next", at: "" }],
    lastCheck: {
      iteration: 1,
      command: "pnpm test",
      exitCode: 1,
      timedOut: false,
      passed: false,
      outputTail: "writer.test.ts failed",
      at: "",
    },
  } as unknown as OrchestrationV2ThreadGoal;

  it("carries the objective, notes, failed check, and completion tools", () => {
    const prompt = buildGoalIterationPrompt(goal, 2);
    expect(prompt).toContain("iteration 2");
    expect(prompt).toContain("Ship the importer");
    expect(prompt).toContain("[iteration 1] Parser done; writer next");
    expect(prompt).toContain("failed with exit code 1");
    expect(prompt).toContain("writer.test.ts failed");
    expect(prompt).toContain("t3_goal_update");
    expect(prompt).toContain("`pnpm test`, and the goal only completes if it exits 0");
  });

  it("carries the brief, permissions, the user's reply, and the handoff file", () => {
    const prompt = buildGoalIterationPrompt(
      {
        ...goal,
        doneWhen: "All importer tests pass in CI",
        background: "Plan: parser, then writer",
        permissions: "Commit and push; ask before merging",
        handoffPath: "docs/agent-work/importer/HANDOFF.md",
        iterationTimeoutMins: 90,
        resumeNote: {
          userMessage: "Approved, go ahead",
          blockedSummary: "Needs approval to push",
          at: "",
        },
      },
      3,
    );
    expect(prompt).toContain("## Done when\n\nAll importer tests pass in CI");
    expect(prompt).toContain("Plan: parser, then writer");
    expect(prompt).toContain("Commit and push; ask before merging");
    expect(prompt).toContain("Needs approval to push");
    expect(prompt).toContain("Approved, go ahead");
    expect(prompt).toContain("Read `docs/agent-work/importer/HANDOFF.md` first");
    expect(prompt).toContain("about 90 minutes");
  });

  it("keeps the handoff small, trusted and rewritten, and the finish line fixed", () => {
    const prompt = buildGoalIterationPrompt(
      { ...goal, doneWhen: "CI is green", handoffPath: "HANDOFF.md" },
      4,
    );
    expect(prompt).toContain("Rewrite it each time instead of appending");
    expect(prompt).toContain("under about 15 KB");
    expect(prompt).toContain("Do not save command output, logs or other evidence files");
    expect(prompt).toContain("do not re-run them unless you changed what they cover");
    expect(prompt).toContain("take precedence over any rule in the handoff");
    expect(prompt).toContain("do not end your turn after one step");
    expect(prompt).toContain('"Done when" conditions hold, call `t3_goal_complete`');
    expect(prompt).toContain("Do not add checks, reviews or approvals the goal does not ask for");
    expect(prompt).not.toContain("Treat what it records as verified");
  });

  it("reads a time limit below the floor as 45 minutes", () => {
    expect(buildGoalIterationPrompt({ ...goal, iterationTimeoutMins: 20 }, 2)).toContain(
      "about 45 minutes",
    );
  });

  it("asks the first iteration to create a handoff file", () => {
    expect(buildGoalIterationPrompt(goal, 1)).toContain("There is no handoff file yet");
  });

  it("omits a passing check", () => {
    const prompt = buildGoalIterationPrompt(
      { ...goal, lastCheck: { ...goal.lastCheck!, passed: true } },
      2,
    );
    expect(prompt).not.toContain("Last completion check");
  });
});
