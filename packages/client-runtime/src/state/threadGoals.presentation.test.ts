import { CommandId, ThreadId, type OrchestrationV2ThreadGoalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  formatGoalBurnGuard,
  formatGoalTokens,
  formatGoalTokensWithUncached,
  formatGoalUsage,
  goalIsEditable,
  goalAwareThreadWorking,
  goalComposerPlaceholder,
  goalControlActions,
  goalDraftRequestMessage,
  goalIterationLabel,
  goalNeedsAttention,
  goalRouteOwnerKey,
  goalRowStatusLabel,
  goalStatusLabel,
  nestGoalIterations,
  parseComposerGoalCommand,
  presentT3Goal,
  resolveGoalComposerIntent,
  selectedGoalIterationKey,
  shownGoalIterations,
} from "./threadGoals.ts";

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

  it("asks the agent to draft the goal without starting with a slash", () => {
    const withObjective = goalDraftRequestMessage("fix the flaky tests");
    expect(withObjective).toMatch(/^Make this a T3 goal: fix the flaky tests\n\n/);
    expect(withObjective).toContain("t3_goal_propose");
    expect(goalDraftRequestMessage(null)).toMatch(/^Make the current task a T3 goal\./);
  });
});

describe("goal presentation", () => {
  it("names what the goal is doing and why it stopped", () => {
    const working = { ...goal, iteration: 3 };
    expect(goalStatusLabel(working)).toBe("Working on iteration 3");
    expect(goalStatusLabel({ ...working, needsInput: true })).toBe("Iteration 3 needs your input");
    expect(goalStatusLabel({ ...working, status: "paused", statusReason: "burn_rate" })).toBe(
      "Paused: provider usage climbed too fast",
    );
    expect(goalStatusLabel({ ...working, status: "paused", statusReason: "child_failed" })).toBe(
      "Paused: iteration 3 failed",
    );
    expect(goalStatusLabel({ ...working, status: "complete" })).toBe("Goal complete");
  });

  it("formats tokens in the native goal row's units", () => {
    expect(formatGoalTokens(950)).toBe("950 tokens");
    expect(formatGoalTokens(48_000)).toBe("48k tokens");
    expect(formatGoalTokens(2_400_000)).toBe("2.4m tokens");
  });

  it("shows uncached tokens beside context tokens, and nothing extra for older goals", () => {
    expect(formatGoalTokensWithUncached(88_000_000, 3_000_000)).toBe("88m tokens (3m uncached)");
    expect(formatGoalTokensWithUncached(88_000_000, undefined)).toBe("88m tokens");
    expect(
      formatGoalUsage({
        usageAccounting: "estimated",
        tokensUsed: 12_000,
        uncachedTokensUsed: 900,
      }),
    ).toBe("~12k tokens (900 uncached)");
    expect(presentT3Goal({ ...goal, tokensUsed: 12_000, uncachedTokensUsed: 2_000 }).usage).toBe(
      "12k tokens (2k uncached)",
    );
  });

  it("reads out the burn guard's latest sample once it has one", () => {
    const burnGuard = { maxPercentPoints: 20, windowMins: 60 };
    expect(formatGoalBurnGuard({ burnGuard: null })).toBe("no burn guard");
    expect(formatGoalBurnGuard({ burnGuard })).toBe("burn guard 20% / 60m");
    expect(
      formatGoalBurnGuard({
        burnGuard,
        usageSample: {
          at: "2026-10-11T00:00:00Z",
          windows: [
            { id: "5h", usedPercent: 41.4 },
            { id: "weekly", usedPercent: 12 },
          ],
          risePoints: 3.2,
        },
      }),
    ).toBe("burn guard 20% / 60m, now +3 (highest window 41%)");
    expect(
      formatGoalBurnGuard({
        burnGuard,
        usageSample: { at: "2026-10-11T00:00:00Z", windows: [], risePoints: 0 },
      }),
    ).toBe("burn guard 20% / 60m, now +0");
  });

  it("allows brief edits only while the goal is paused or blocked", () => {
    expect(goalIsEditable({ ...goal, status: "paused" })).toBe(true);
    expect(goalIsEditable({ ...goal, status: "blocked" })).toBe(true);
    for (const status of ["active", "usageLimited", "complete", "stopped"] as const)
      expect(goalIsEditable({ ...goal, status })).toBe(false);
  });

  it("leads blocked and finished goals with the agent's note, and shows usage once work began", () => {
    expect(presentT3Goal({ ...goal, tokensUsed: 12_000 })).toEqual({
      title: "Working on iteration 2",
      objective: "Ship",
      usage: "12k tokens",
      canResume: false,
    });
    expect(
      presentT3Goal({ ...goal, status: "blocked", summaryNote: "Needs merge approval" }),
    ).toMatchObject({ objective: "Needs merge approval", canResume: true });
    expect(presentT3Goal({ ...goal, iteration: 0, tokensUsed: 0 }).usage).toBeNull();
  });

  it("asks for attention only when the goal waits on the user", () => {
    expect(goalNeedsAttention({ ...goal, needsInput: true })).toBe(true);
    expect(goalNeedsAttention({ ...goal, status: "blocked" })).toBe(true);
    expect(goalNeedsAttention({ ...goal, status: "paused", statusReason: "no_progress" })).toBe(
      true,
    );
    expect(goalNeedsAttention({ ...goal, status: "paused", statusReason: "user" })).toBe(false);
    expect(goalNeedsAttention({ ...goal, status: "usageLimited" })).toBe(false);
  });

  it("says where a message in the goal thread goes", () => {
    expect(goalComposerPlaceholder({ ...goal, status: "blocked" })).toMatch(/resume the goal/);
    expect(goalComposerPlaceholder(goal)).toBe("Message the running goal iteration");
    expect(goalComposerPlaceholder({ ...goal, status: "usageLimited" })).toMatch(
      /next goal iteration/,
    );
  });

  it("puts goal threads on the Working shelf while an iteration works, not while it waits", () => {
    expect(goalAwareThreadWorking(goal, false)).toBe(true);
    expect(goalAwareThreadWorking({ ...goal, needsInput: true }, true)).toBe(false);
    expect(goalAwareThreadWorking({ ...goal, status: "paused", statusReason: "user" }, true)).toBe(
      true,
    );
    expect(goalAwareThreadWorking(null, true)).toBe(true);
    expect(goalAwareThreadWorking(null, false)).toBe(false);
  });

  it("gives thread rows a short label for the iteration or the reason for attention", () => {
    const summary = { ...goal, iteration: 4 };
    expect(goalRowStatusLabel(summary, "working")).toBe("Iteration 4");
    expect(goalRowStatusLabel({ ...summary, iteration: 0 }, "working")).toBe("Goal");
    expect(goalRowStatusLabel({ ...summary, status: "blocked" }, "input")).toBe("Blocked");
    expect(goalRowStatusLabel({ ...summary, needsInput: true }, "input")).toBe("Input");
    expect(goalRowStatusLabel({ ...summary, status: "complete" }, "ready")).toBeNull();
    expect(goalRowStatusLabel(summary, "approval")).toBeNull();
  });
});

describe("goal threads in lists", () => {
  const ownerId = ThreadId.make("owner");
  const thread = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    environmentId: "local",
    archivedAt: null as string | null,
    createdAt: "2026-10-01T00:00:00Z",
    title: id,
    lineage: { relationshipToParent: null as string | null },
    goalIteration: null as {
      parentThreadId: ThreadId;
      goalId: CommandId;
      iteration: number;
    } | null,
    ...patch,
  });
  const owner = thread(ownerId);
  const iteration = (number: number, patch: Record<string, unknown> = {}) =>
    thread(`iteration-${number}`, {
      title: `Goal #${number}: Ship it`,
      goalIteration: { parentThreadId: ownerId, goalId: goal.id, iteration: number },
      ...patch,
    });

  it("nests newest iterations under a listed goal thread and keeps orphans top-level", () => {
    const nested = nestGoalIterations([iteration(1), owner, iteration(3), iteration(2)]);
    expect(nested.roots.map((row) => row.id)).toEqual([ownerId]);
    expect(nested.iterations.get(`local:${ownerId}`)?.map((row) => row.id)).toEqual([
      "iteration-3",
      "iteration-2",
      "iteration-1",
    ]);
    expect(nestGoalIterations([iteration(1)]).roots.map((row) => row.id)).toEqual(["iteration-1"]);
    expect(
      nestGoalIterations([
        { ...owner, archivedAt: "2026-10-02T00:00:00Z" },
        iteration(1),
      ]).roots.map((row) => row.id),
    ).toEqual(["iteration-1"]);
    expect(
      nestGoalIterations([{ ...owner, environmentId: "remote" }, iteration(1)]).roots.map(
        (row) => row.id,
      ),
    ).toEqual([ownerId, "iteration-1"]);
    expect(
      nestGoalIterations([
        owner,
        iteration(1, { lineage: { relationshipToParent: "subagent" } }),
        iteration(2, { archivedAt: "2026-10-02T00:00:00Z" }),
      ]).iterations.size,
    ).toBe(0);
  });

  it("keeps a selected iteration's goal thread in view while it is listed", () => {
    const route = "local:iteration-1";
    expect(goalRouteOwnerKey([owner, iteration(1)], route)).toBe(`local:${ownerId}`);
    expect(goalRouteOwnerKey([iteration(1)], route)).toBe(route);
    expect(
      goalRouteOwnerKey([{ ...owner, archivedAt: "2026-10-02T00:00:00Z" }, iteration(1)], route),
    ).toBe(route);
    expect(goalRouteOwnerKey([owner, iteration(1)], null)).toBeNull();
    expect(goalRouteOwnerKey([owner, iteration(1)], `local:${ownerId}`)).toBe(`local:${ownerId}`);
  });

  it("hands each row the selection only when it is one of its iterations", () => {
    const iterations = [iteration(2), iteration(1)];
    expect(selectedGoalIterationKey(iterations, "local:iteration-1")).toBe("local:iteration-1");
    expect(selectedGoalIterationKey(iterations, "local:elsewhere")).toBeNull();
    expect(selectedGoalIterationKey(undefined, "local:iteration-1")).toBeNull();
  });

  it("shows the running iteration first, then the newest, and always the selected one", () => {
    const iterations = [5, 4, 3, 2, 1].map((number) => iteration(number));
    const shown = (input: Partial<Parameters<typeof shownGoalIterations>[0]>) =>
      shownGoalIterations({
        iterations,
        currentThreadId: null,
        selectedKey: null,
        expanded: false,
        parked: false,
        ...input,
      }).map((row) => Number(row.id.replace("iteration-", "")));
    expect(shown({})).toEqual([5, 4, 3]);
    expect(shown({ currentThreadId: "iteration-2" })).toEqual([2, 5, 4]);
    expect(shown({ parked: true })).toEqual([]);
    expect(shown({ parked: true, currentThreadId: "iteration-5" })).toEqual([5]);
    expect(shown({ selectedKey: "local:iteration-1" })).toEqual([5, 4, 3, 1]);
    expect(shown({ expanded: true })).toEqual([5, 4, 3, 2, 1]);
    expect(shown({ expanded: true, expandedLimit: 2 })).toEqual([5, 4]);
    expect(goalIterationLabel(iteration(3))).toBe("#3 Ship it");
    expect(goalIterationLabel({ title: "Goal iteration 7: Fix parser", goalIteration: null })).toBe(
      "Fix parser",
    );
  });
});
