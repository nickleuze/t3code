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

describe("/goal composer command", () => {
  it("parses a bare command and one with an objective", () => {
    expect(parseComposerGoalCommand("/goal")).toEqual({ objective: null });
    expect(parseComposerGoalCommand("  /GOAL   migrate the api\nwith tests ")).toEqual({
      objective: "migrate the api\nwith tests",
    });
    expect(parseComposerGoalCommand("/goals")).toBeNull();
    expect(parseComposerGoalCommand("please /goal x")).toBeNull();
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
