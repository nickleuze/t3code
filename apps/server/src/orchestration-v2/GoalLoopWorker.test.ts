import type { OrchestrationV2ThreadGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { burnGuardTripped, childIterationTokens, childOutcome } from "./GoalLoopWorker.ts";
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

  it("omits a passing check", () => {
    const prompt = buildGoalIterationPrompt(
      { ...goal, lastCheck: { ...goal.lastCheck!, passed: true } },
      2,
    );
    expect(prompt).not.toContain("Last completion check");
  });
});
