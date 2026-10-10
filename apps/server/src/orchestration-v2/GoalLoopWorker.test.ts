import { describe, expect, it } from "vite-plus/test";

import {
  burnGuardTripped,
  childContextFraction,
  childIterationTokens,
  childOutcome,
  iterationDeadlines,
  largestUsageRise,
} from "./GoalLoopWorker.ts";

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

  it("reports the largest rise even while it stays under the limit", () => {
    expect(
      largestUsageRise([
        {
          atMs: 0,
          windows: [
            { id: "session", usedPercent: 10 },
            { id: "weekly", usedPercent: 40 },
          ],
        },
        {
          atMs: 1,
          windows: [
            { id: "session", usedPercent: 14 },
            { id: "weekly", usedPercent: 41 },
          ],
        },
      ]),
    ).toEqual({ windowId: "session", risePoints: 4 });
    expect(largestUsageRise([])).toBeNull();
  });
});

describe("iteration accounting", () => {
  it("sums context tokens and, separately, tokens not served from cache", () => {
    expect(
      childIterationTokens([
        {
          turnTokenUsage: {
            usageStatus: "complete",
            inputTokens: 900,
            cachedInputTokens: 800,
            outputTokens: 100,
          },
        },
        { turnTokenUsage: { usageStatus: "complete", inputTokens: 1_500, outputTokens: 500 } },
      ] as never),
    ).toEqual({ tokens: 3_000, uncachedTokens: 2_200, accounting: "exact" });
  });

  it("marks partial reports as estimates and missing reports as unavailable", () => {
    expect(
      childIterationTokens([
        { turnTokenUsage: { usageStatus: "complete", inputTokens: 10, outputTokens: 5 } },
        {},
      ] as never),
    ).toEqual({ tokens: 15, uncachedTokens: 15, accounting: "estimated" });
    expect(childIterationTokens([{}] as never)).toEqual({
      tokens: 0,
      uncachedTokens: 0,
      accounting: "unavailable",
    });
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
  it("nudges with a tenth of the limit left", () => {
    expect(iterationDeadlines(45)).toEqual({ wrapUpMs: 40.5 * 60_000, timeoutMs: 45 * 60_000 });
    expect(iterationDeadlines(120)).toEqual({ wrapUpMs: 108 * 60_000, timeoutMs: 120 * 60_000 });
  });
});

describe("context rollover", () => {
  it("reads the latest live turn usage, then the provider thread's snapshot", () => {
    const thread = { contextUsage: { usedTokens: 50_000, maxTokens: 200_000 } };
    expect(
      childContextFraction(
        [
          { tokenUsage: { usedTokens: 10_000, maxTokens: 100_000, updatedAt: "" } },
          { tokenUsage: { usedTokens: 70_000, maxTokens: 100_000, updatedAt: "" } },
          {},
        ],
        thread,
      ),
    ).toBe(0.7);
    expect(childContextFraction([{}], thread)).toBe(0.25);
    // A live report without a window size borrows the thread's.
    expect(
      childContextFraction([{ tokenUsage: { usedTokens: 100_000, updatedAt: "" } }], thread),
    ).toBe(0.5);
  });

  it("is unknown without a window size", () => {
    expect(
      childContextFraction([{ tokenUsage: { usedTokens: 1, updatedAt: "" } }], undefined),
    ).toBeNull();
    expect(childContextFraction([], { contextUsage: null })).toBeNull();
  });
});
