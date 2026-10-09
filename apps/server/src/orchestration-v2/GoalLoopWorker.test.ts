import type { OrchestrationV2ThreadGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  burnGuardTripped,
  childIterationTokens,
  childOutcome,
  iterationDeadlines,
} from "./GoalLoopWorker.ts";
import { buildGoalIterationPrompt } from "./GoalPrompt.ts";

const guard = { maxPercentPoints: 20, windowMins: 60 };
const sample = (atMs: number, usedPercent: number) => ({
  atMs,
  windows: [{ id: "session", usedPercent }],
});

describe("burn guard", () => {
  it("trips when a window rises past the allowed points", () => {
    expect(burnGuardTripped([sample(0, 10), sample(1, 25)], guard)).toBeNull();
    expect(burnGuardTripped([sample(0, 10), sample(1, 25), sample(2, 31)], guard)).toEqual({
      windowId: "session",
      risePoints: 21,
    });
  });

  it("measures from the reset after a provider window resets", () => {
    expect(burnGuardTripped([sample(0, 80), sample(1, 2), sample(2, 15)], guard)).toBeNull();
  });
});

describe("iteration accounting", () => {
  it("sums reported input and output tokens", () => {
    expect(
      childIterationTokens([
        { turnTokenUsage: { usageStatus: "complete", inputTokens: 900, outputTokens: 100 } },
        { turnTokenUsage: { usageStatus: "complete", inputTokens: 1_500, outputTokens: 500 } },
      ] as never),
    ).toEqual({ tokens: 3_000, accounting: "exact" });
  });

  it("marks partial reports as estimates and missing reports as unavailable", () => {
    expect(
      childIterationTokens([
        { turnTokenUsage: { usageStatus: "complete", inputTokens: 10, outputTokens: 5 } },
        {},
      ] as never),
    ).toEqual({ tokens: 15, accounting: "estimated" });
    expect(childIterationTokens([{}] as never)).toEqual({ tokens: 0, accounting: "unavailable" });
  });

  it("classifies how a child ended", () => {
    expect(childOutcome({ status: "completed" }, null).outcome).toBe("completed");
    expect(
      childOutcome(
        { status: "failed" },
        { lastErrorClass: "usage_limit", usageLimitResetAt: "2026-10-04T17:00:00.000Z" },
      ),
    ).toEqual({ outcome: "usage_limited", resumeAt: "2026-10-04T17:00:00.000Z" });
    expect(childOutcome({ status: "failed" }, null).outcome).toBe("failed");
    expect(childOutcome({ status: "cancelled" }, null).outcome).toBe("interrupted");
    expect(childOutcome(undefined, null).outcome).toBe("interrupted");
  });
});

describe("iteration deadlines", () => {
  it("nudges a quarter early on short limits and 15 minutes early on long ones", () => {
    expect(iterationDeadlines(20)).toEqual({ wrapUpMs: 15 * 60_000, timeoutMs: 20 * 60_000 });
    expect(iterationDeadlines(120)).toEqual({ wrapUpMs: 105 * 60_000, timeoutMs: 120 * 60_000 });
  });
});

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
