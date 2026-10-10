import { CommandId, ThreadId, type OrchestrationV2ThreadGoalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { goalControlActions, resolveGoalComposerIntent } from "./threadGoals.ts";

const goal: OrchestrationV2ThreadGoalSummary = {
  id: CommandId.make("goal"),
  objective: "Ship",
  status: "active",
  statusReason: null,
  iteration: 2,
  tokensUsed: 100,
  needsInput: false,
  currentChildThreadId: ThreadId.make("child"),
};
const input = {
  text: "Keep the worktree",
  goal,
  supportsGoals: true,
  canMutate: true,
  isIteration: false,
  isSubagent: false,
  hasNonTextContent: false,
};

describe("mobile goal send ownership", () => {
  it.each(["active", "paused", "blocked", "usageLimited"] as const)(
    "routes %s owner messages through the goal",
    (status) => {
      expect(resolveGoalComposerIntent({ ...input, goal: { ...goal, status } })).toEqual({
        kind: "reply",
        goalId: goal.id,
        text: input.text,
      });
    },
  );
  it.each(["complete", "stopped"] as const)("allows ordinary conversation after %s", (status) => {
    expect(resolveGoalComposerIntent({ ...input, goal: { ...goal, status } })).toEqual({
      kind: "ordinary",
      text: input.text,
    });
  });
  it.each([
    { canMutate: false },
    { supportsGoals: false },
    { hasNonTextContent: true },
    { text: " " },
  ])("never falls through to owner provider work on refusal: %j", (change) => {
    expect(resolveGoalComposerIntent({ ...input, ...change }).kind).toBe("blocked");
  });
  it("drafts a proposal and leaves provider-native /goal alone", () => {
    const result = resolveGoalComposerIntent({ ...input, goal: null, text: "/t3-goal Ship" });
    expect(result.kind).toBe("ordinary");
    if (result.kind !== "ordinary") throw new Error("Expected a draft request");
    expect(result.text).toMatch(/^Make this a T3 goal: Ship/);
    expect(result.text).toContain("t3_goal_propose");
    expect(resolveGoalComposerIntent({ ...input, goal: null, text: "/goal native" })).toEqual({
      kind: "ordinary",
      text: "/goal native",
    });
  });
  it.each([
    { isSubagent: true },
    { isIteration: true },
    { canMutate: false },
    { supportsGoals: false },
    { hasNonTextContent: true },
  ])("rejects T3 creation in an ineligible send: %j", (change) => {
    expect(
      resolveGoalComposerIntent({ ...input, goal: null, text: "/t3-goal", ...change }).kind,
    ).toBe("blocked");
  });
});

describe("goal controls", () => {
  it("keeps Stop available while paused and holds Clear until the child settles", () => {
    expect(goalControlActions(goal)).toEqual(["pause", "stop"]);
    expect(goalControlActions({ ...goal, status: "paused" })).toEqual(["resume", "stop"]);
    expect(goalControlActions({ ...goal, status: "usageLimited" })).toEqual(["resume", "stop"]);
    expect(goalControlActions({ ...goal, status: "stopped" })).toEqual([]);
    expect(goalControlActions({ ...goal, status: "stopped", currentChildThreadId: null })).toEqual([
      "clear",
    ]);
  });
});
