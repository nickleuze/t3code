import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2GoalAdvanceStep,
  type OrchestrationV2ThreadGoal,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGoalCommand,
  DEFAULT_GOAL_BURN_GUARD,
  type GoalCommandInput,
  goalSummary,
  MAX_GOAL_NOTES_TOTAL_CHARS,
} from "./GoalState.ts";

const NOW = "2026-10-04T12:00:00.000Z";
const GOAL_ID = CommandId.make("command:goal");
const CHILD = ThreadId.make("thread:child-1");

type GoalThread = Pick<
  OrchestrationV2AppThread,
  "goal" | "goalIteration" | "lineage" | "archivedAt"
>;

const rootThread = (goal: OrchestrationV2ThreadGoal | null = null): GoalThread => ({
  goal,
  goalIteration: null,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("thread:root"),
  } as GoalThread["lineage"],
  archivedAt: null,
});

function apply(thread: GoalThread, command: GoalCommandInput): OrchestrationV2ThreadGoal | null {
  const result = applyGoalCommand(thread, command, NOW);
  if (!result.ok) throw new Error(result.reason);
  return result.goal;
}

function rejection(thread: GoalThread, command: GoalCommandInput): string {
  const result = applyGoalCommand(thread, command, NOW);
  if (result.ok) throw new Error("expected rejection");
  return result.reason;
}

function newGoal(overrides: { checkCommand?: string | null; noProgressLimit?: number } = {}) {
  return apply(rootThread(), {
    type: "set",
    commandId: GOAL_ID,
    objective: "Make the test suite pass",
    checkCommand: overrides.checkCommand ?? null,
    burnGuard: undefined,
    noProgressLimit: overrides.noProgressLimit,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5",
    } as OrchestrationV2ThreadGoal["modelSelection"],
    runtimeMode: "full-access",
    doneWhen: null,
    background: null,
    permissions: null,
    iterationTimeoutMins: undefined,
  })!;
}

function started(goal: OrchestrationV2ThreadGoal, iteration = goal.iteration + 1) {
  return apply(rootThread(goal), {
    type: "iteration.start",
    goalId: GOAL_ID,
    iteration,
    childThreadId: CHILD,
    baselineRef: null,
  })!;
}

function advance(goal: OrchestrationV2ThreadGoal, step: OrchestrationV2GoalAdvanceStep) {
  return apply(rootThread(goal), {
    type: "advance",
    goalId: GOAL_ID,
    iteration: goal.iteration,
    step,
  })!;
}

function report(
  goal: OrchestrationV2ThreadGoal,
  value: Extract<GoalCommandInput, { type: "report" }>["report"],
) {
  return apply(rootThread(goal), {
    type: "report",
    goalId: GOAL_ID,
    iteration: goal.iteration,
    childThreadId: CHILD,
    report: value,
  })!;
}

const finished = (
  childOutcome: "completed" | "failed" | "interrupted" | "usage_limited" = "completed",
  workspaceChanged: boolean | null = false,
): OrchestrationV2GoalAdvanceStep => ({
  type: "iteration_finished",
  childOutcome,
  tokens: 1_000,
  accounting: "exact",
  workspaceChanged,
  resumeAt: childOutcome === "usage_limited" ? "2026-10-04T17:00:00.000Z" : null,
});

const control = (goal: OrchestrationV2ThreadGoal, action: "pause" | "resume" | "stop" | "clear") =>
  apply(rootThread(goal), { type: "control", goalId: GOAL_ID, action, burnGuard: undefined });

const message = (goal: OrchestrationV2ThreadGoal, text: string) =>
  apply(rootThread(goal), { type: "message", goalId: GOAL_ID, text })!;

describe("goal state", () => {
  it("sets an active goal with defaults and refuses a second live goal", () => {
    const goal = newGoal();
    expect(goal).toMatchObject({
      status: "active",
      iteration: 0,
      noProgressLimit: 3,
      burnGuard: DEFAULT_GOAL_BURN_GUARD,
      current: null,
    });
    expect(
      rejection(rootThread(goal), {
        type: "set",
        commandId: CommandId.make("command:other"),
        objective: "Something else",
        checkCommand: null,
        burnGuard: null,
        noProgressLimit: undefined,
        modelSelection: goal.modelSelection,
        runtimeMode: goal.runtimeMode,
        doneWhen: null,
        background: null,
        permissions: null,
        iterationTimeoutMins: undefined,
      }),
    ).toMatch(/already has a goal/);
  });

  it("waits for a stopped goal's last iteration before starting another", () => {
    const stopping = control(started(newGoal()), "stop")!;
    expect(
      rejection(rootThread(stopping), {
        type: "set",
        commandId: CommandId.make("command:next"),
        objective: "Next goal",
        checkCommand: null,
        burnGuard: null,
        noProgressLimit: undefined,
        modelSelection: stopping.modelSelection,
        runtimeMode: stopping.runtimeMode,
        doneWhen: null,
        background: null,
        permissions: null,
        iterationTimeoutMins: undefined,
      }),
    ).toMatch(/last iteration/);
  });

  it("refuses goals on goal iteration threads", () => {
    const thread: GoalThread = {
      ...rootThread(),
      goalIteration: {
        parentThreadId: ThreadId.make("thread:root"),
        goalId: GOAL_ID,
        iteration: 1,
      },
    };
    expect(
      rejection(thread, {
        type: "set",
        commandId: GOAL_ID,
        objective: "Nested",
        checkCommand: null,
        burnGuard: null,
        noProgressLimit: undefined,
        modelSelection: newGoal().modelSelection,
        runtimeMode: "full-access",
        doneWhen: null,
        background: null,
        permissions: null,
        iterationTimeoutMins: undefined,
      }),
    ).toMatch(/cannot run their own goal/);
  });

  it("starts iterations in order", () => {
    const goal = started(newGoal());
    expect(goal.iteration).toBe(1);
    expect(goal.current).toMatchObject({ iteration: 1, childThreadId: CHILD, phase: "running" });
    expect(
      rejection(rootThread(goal), {
        type: "iteration.start",
        goalId: GOAL_ID,
        iteration: 2,
        childThreadId: CHILD,
        baselineRef: null,
      }),
    ).toMatch(/already running/);
  });

  it("continues after an iteration that made progress", () => {
    const goal = advance(
      report(started(newGoal()), { type: "note", text: "Fixed parser" }),
      finished(),
    );
    expect(goal).toMatchObject({ status: "active", current: null, consecutiveNoProgress: 0 });
    expect(goal.history).toEqual([
      expect.objectContaining({ iteration: 1, outcome: "continued", tokens: 1_000 }),
    ]);
    expect(goal.progressNotes.map((note) => note.text)).toEqual(["Fixed parser"]);
    expect(goal.tokensUsed).toBe(1_000);
  });

  it("pauses after consecutive iterations without notes or workspace changes", () => {
    let goal = newGoal({ noProgressLimit: 2 });
    goal = advance(started(goal), finished("completed", false));
    expect(goal).toMatchObject({ status: "active", consecutiveNoProgress: 1 });
    goal = advance(started(goal), finished("completed", false));
    expect(goal).toMatchObject({ status: "paused", statusReason: "no_progress" });
  });

  it("counts a workspace change as progress", () => {
    let goal = newGoal({ noProgressLimit: 1 });
    goal = advance(started(goal), finished("completed", true));
    expect(goal).toMatchObject({ status: "active", consecutiveNoProgress: 0 });
  });

  it("completes on a claim when there is no check command", () => {
    let goal = report(started(newGoal()), {
      type: "claim",
      status: "complete",
      summary: "All green",
    });
    goal = advance(goal, finished());
    expect(goal).toMatchObject({
      status: "complete",
      completedSummary: "All green",
      current: null,
    });
  });

  it("runs the check before accepting a claim and continues when it fails", () => {
    let goal = report(started(newGoal({ checkCommand: "pnpm test" })), {
      type: "claim",
      status: "complete",
      summary: "Done",
    });
    goal = advance(goal, finished("completed", true));
    expect(goal.current).toMatchObject({ phase: "checking", finished: { tokens: 1_000 } });
    expect(goal.status).toBe("active");

    const failed = advance(goal, {
      type: "check_finished",
      result: {
        iteration: 1,
        command: "pnpm test",
        exitCode: 1,
        timedOut: false,
        passed: false,
        outputTail: "1 failing",
        at: NOW,
      },
    });
    expect(failed).toMatchObject({ status: "active", current: null });
    expect(failed.lastCheck).toMatchObject({ passed: false, outputTail: "1 failing" });
    expect(failed.history.at(-1)?.outcome).toBe("check_failed");

    const passed = advance(goal, {
      type: "check_finished",
      result: {
        iteration: 1,
        command: "pnpm test",
        exitCode: 0,
        timedOut: false,
        passed: true,
        outputTail: "",
        at: NOW,
      },
    });
    expect(passed).toMatchObject({ status: "complete", completedSummary: "Done" });
  });

  it("marks the goal blocked when the agent reports it is stuck", () => {
    let goal = report(started(newGoal()), {
      type: "claim",
      status: "blocked",
      summary: "Needs an API key",
    });
    goal = advance(goal, finished());
    expect(goal).toMatchObject({
      status: "blocked",
      statusReason: "agent",
      completedSummary: "Needs an API key",
    });
    expect(control(goal, "resume")).toMatchObject({ status: "active", statusReason: null });
  });

  it("pauses when the child fails and waits for a reset when it hits a usage limit", () => {
    expect(advance(started(newGoal()), finished("failed"))).toMatchObject({
      status: "paused",
      statusReason: "child_failed",
    });
    const limited = advance(started(newGoal()), finished("usage_limited"));
    expect(limited).toMatchObject({
      status: "usageLimited",
      resumeAt: "2026-10-04T17:00:00.000Z",
    });
    expect(advance(limited, { type: "resumed" })).toMatchObject({
      status: "active",
      resumeAt: null,
    });
  });

  it("keeps a user pause or stop when the running iteration ends", () => {
    const paused = control(started(newGoal()), "pause")!;
    expect(paused).toMatchObject({ status: "paused", statusReason: "user" });
    expect(advance(paused, finished("completed"))).toMatchObject({
      status: "paused",
      statusReason: "user",
      current: null,
    });

    const stopped = control(started(newGoal()), "stop")!;
    expect(advance(stopped, finished("interrupted"))).toMatchObject({
      status: "stopped",
      current: null,
    });
  });

  it("drops a child's report after the iteration moved on", () => {
    const goal = advance(started(newGoal()), finished());
    expect(
      rejection(rootThread(goal), {
        type: "report",
        goalId: GOAL_ID,
        iteration: 1,
        childThreadId: CHILD,
        report: { type: "note", text: "late" },
      }),
    ).toMatch(/not running the current goal iteration/);
  });

  it("only clears a goal with no iteration running", () => {
    const running = control(started(newGoal()), "stop")!;
    expect(
      rejection(rootThread(running), {
        type: "control",
        goalId: GOAL_ID,
        action: "clear",
        burnGuard: undefined,
      }),
    ).toMatch(/Wait for the running iteration/);
    expect(control(advance(running, finished("interrupted")), "clear")).toBeNull();
  });

  it("pauses at the safety cap and grants more on resume", () => {
    let goal = { ...newGoal(), safetyCap: 1 };
    goal = advance(report(started(goal), { type: "note", text: "progress" }), finished());
    expect(goal).toMatchObject({ status: "paused", statusReason: "safety_cap" });
    expect(control(goal, "resume")!.safetyCap).toBeGreaterThan(1);
  });

  it("keeps the newest notes within the size cap", () => {
    let goal = started(newGoal());
    const text = "x".repeat(1_500);
    for (let index = 0; index < 8; index += 1) {
      goal = report(goal, { type: "note", text: `${index}${text}` });
    }
    const total = goal.progressNotes.reduce((sum, note) => sum + note.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_GOAL_NOTES_TOTAL_CHARS);
    expect(goal.progressNotes.at(-1)?.text.startsWith("7")).toBe(true);
  });

  it("summarizes needs-input for thread shells", () => {
    const goal = advance(started(newGoal()), {
      type: "child_waiting",
      requestId: "request:1" as never,
      kind: "user_input",
    });
    expect(goalSummary(goal)).toMatchObject({
      status: "active",
      needsInput: true,
      currentChildThreadId: CHILD,
    });
  });
  it("resumes a blocked goal from a reply and tells the next iteration why it stopped", () => {
    const blocked = advance(
      report(started(newGoal()), {
        type: "claim",
        status: "blocked",
        summary: "Needs merge approval",
      }),
      finished(),
    );
    expect(goalSummary(blocked)?.summaryNote).toBe("Needs merge approval");

    const resumed = message(blocked, "Approved, merge it");
    expect(resumed).toMatchObject({
      status: "active",
      completedSummary: null,
      resumeNote: { userMessage: "Approved, merge it", blockedSummary: "Needs merge approval" },
    });
    // The next iteration's prompt carries the note, so starting it consumes the note.
    expect(started(resumed).resumeNote).toBeNull();
  });

  it("clears a stale summary when a blocked goal resumes from the banner", () => {
    const blocked = advance(
      report(started(newGoal()), { type: "claim", status: "blocked", summary: "Waiting on CI" }),
      finished(),
    );
    expect(control(blocked, "resume")).toMatchObject({
      completedSummary: null,
      resumeNote: { userMessage: null, blockedSummary: "Waiting on CI" },
    });
  });

  it("queues a reply for the running iteration and carries undelivered ones forward", () => {
    const running = message(message(started(newGoal()), "Use the staging bucket"), "And skip iOS");
    expect(running.current?.pendingMessages?.map((entry) => entry.text)).toEqual([
      "Use the staging bucket",
      "And skip iOS",
    ]);
    const delivered = advance(running, { type: "messages_delivered", count: 1 });
    expect(delivered.current?.pendingMessages?.map((entry) => entry.text)).toEqual([
      "And skip iOS",
    ]);
    expect(advance(delivered, finished("completed", true)).resumeNote?.userMessage).toBe(
      "And skip iOS",
    );
  });

  it("holds a reply between iterations and refuses one for an ended goal", () => {
    const between = advance(report(started(newGoal()), { type: "note", text: "n" }), finished());
    expect(message(between, "Prioritize docs").resumeNote?.userMessage).toBe("Prioritize docs");
    const complete = advance(
      report(started(newGoal()), { type: "claim", status: "complete", summary: "done" }),
      finished(),
    );
    expect(
      rejection(rootThread(complete), { type: "message", goalId: GOAL_ID, text: "more" }),
    ).toMatch(/has ended/);
  });

  it("keeps going after an iteration runs out of time", () => {
    const timing = advance(advance(started(newGoal()), { type: "wrap_up_sent" }), {
      type: "timed_out",
    });
    expect(timing.current).toMatchObject({ wrapUpSentAt: NOW, timedOutAt: NOW });
    const after = advance(timing, finished("interrupted", true));
    expect(after).toMatchObject({ status: "active", current: null, consecutiveNoProgress: 0 });
    expect(after.history.at(-1)?.outcome).toBe("timed_out");
  });

  it("pauses when timeouts keep coming without progress", () => {
    let goal = newGoal({ noProgressLimit: 2 });
    for (let index = 0; index < 2; index += 1) {
      goal = advance(advance(started(goal), { type: "timed_out" }), finished("interrupted", false));
    }
    expect(goal).toMatchObject({ status: "paused", statusReason: "no_progress" });
  });

  it("records the handoff file from a note", () => {
    const goal = report(started(newGoal()), {
      type: "note",
      text: "Parser done",
      handoffPath: "docs/agent-work/parser/HANDOFF.md",
    });
    expect(goal.handoffPath).toBe("docs/agent-work/parser/HANDOFF.md");
  });
});
