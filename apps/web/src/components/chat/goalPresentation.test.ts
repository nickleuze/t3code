import { CommandId, type OrchestrationV2ThreadGoalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatGoalTokens, goalStatusLabel, parseComposerGoalCommand } from "./goalPresentation";

const goal: OrchestrationV2ThreadGoalSummary = {
  id: CommandId.make("command:goal"),
  objective: "Ship it",
  status: "active",
  statusReason: null,
  iteration: 3,
  tokensUsed: 0,
  needsInput: false,
  currentChildThreadId: null,
};

describe("/t3-goal composer command", () => {
  it("parses a bare command and one with an objective", () => {
    expect(parseComposerGoalCommand("/t3-goal")).toEqual({ objective: null });
    expect(parseComposerGoalCommand("  /T3-GOAL   migrate the api\nwith tests ")).toEqual({
      objective: "migrate the api\nwith tests",
    });
    expect(parseComposerGoalCommand("/goal")).toBeNull();
    expect(parseComposerGoalCommand("/goal native objective")).toBeNull();
    expect(parseComposerGoalCommand("/t3-goals")).toBeNull();
    expect(parseComposerGoalCommand("please /t3-goal x")).toBeNull();
  });
});

describe("goal status label", () => {
  it("names what the goal is doing and why it stopped", () => {
    expect(goalStatusLabel(goal)).toBe("Working on iteration 3");
    expect(goalStatusLabel({ ...goal, needsInput: true })).toBe("Iteration 3 needs your input");
    expect(goalStatusLabel({ ...goal, status: "paused", statusReason: "burn_rate" })).toBe(
      "Paused: provider usage climbed too fast",
    );
    expect(goalStatusLabel({ ...goal, status: "paused", statusReason: "child_failed" })).toBe(
      "Paused: iteration 3 failed",
    );
    expect(goalStatusLabel({ ...goal, status: "complete" })).toBe("Goal complete");
  });

  it("formats token counts compactly", () => {
    expect(formatGoalTokens(950)).toBe("950 tokens");
    expect(formatGoalTokens(4_250)).toBe("4.3k tokens");
    expect(formatGoalTokens(48_000)).toBe("48k tokens");
    expect(formatGoalTokens(2_400_000)).toBe("2.4M tokens");
  });
});
