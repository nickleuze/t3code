import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import { CommandId, ThreadId, type OrchestrationV2ThreadGoalSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadNotificationGate,
  resolveThreadGoalNotification,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  settled: false,
  completedAt: null,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  settled: true,
  completedAt: at,
});
const visible = { archived: false, quiet: false };

function harness() {
  const notify = vi.fn();
  const gate = createThreadNotificationGate<string>(notify);
  let prior: ThreadNotificationObservation | undefined;
  const observe = (next: ThreadNotificationObservation, options = visible) => {
    gate.observe("thread", prior, next, options);
    prior = next;
  };
  return { gate, notify, observe };
}

describe("createThreadNotificationGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a completion when the thread resumes within the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    observe(working);
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies a real completion once after the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies attention at once and replaces a pending completion", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    vi.advanceTimersByTime(60_000);
    // The request resolves and the same run reads as completed again.
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("notifies one completion across continuation gaps", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(2));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(3));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("keeps a completion interrupted by attention after a working gap from firing", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    vi.advanceTimersByTime(60_000);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("adds nothing when attention follows a completion that already fired", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    observe({ attention: "run-1:limited", settled: false, completedAt: null });
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("still notifies a newer completion after attention", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-2:approval", settled: false, completedAt: null });
    observe(working);
    observe(completed(2));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("ignores unrelated updates while a completion waits", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies a run that settles again after a brief runtime blip", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("restarts the grace when a newer completion replaces a pending one", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe(completed(2));
    vi.advanceTimersByTime(1_500);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drops a pending completion on archive, stop request, removal or clear", () => {
    for (const end of [
      (h: ReturnType<typeof harness>) => h.observe(completed(1), { ...visible, archived: true }),
      (h: ReturnType<typeof harness>) =>
        h.observe({ ...completed(1) }, { ...visible, quiet: true }),
      (h: ReturnType<typeof harness>) => h.gate.retain(new Set()),
      (h: ReturnType<typeof harness>) => h.gate.clear(),
    ]) {
      const h = harness();
      h.observe(working);
      h.observe(completed(1));
      end(h);
      vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
      expect(h.notify).not.toHaveBeenCalled();
    }
  });

  it("never notifies a stopped run or the first observation", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("resolveThreadGoalNotification", () => {
  const goal = (
    overrides: Partial<OrchestrationV2ThreadGoalSummary> = {},
  ): OrchestrationV2ThreadGoalSummary => ({
    id: CommandId.make("goal-1"),
    objective: "Fix the login form",
    status: "active",
    statusReason: null,
    iteration: 1,
    tokensUsed: 0,
    needsInput: false,
    currentChildThreadId: ThreadId.make("iteration-1"),
    ...overrides,
  });
  const requestedAt = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");
  const idle = { hasPendingApprovals: false, hasPendingUserInput: false };
  const resolve = (
    t3Goal: OrchestrationV2ThreadGoalSummary | null,
    runStatus: Parameters<typeof resolveThreadGoalNotification>[2] = "ready",
    thread = idle,
  ) =>
    resolveThreadGoalNotification({ t3Goal, latestRunRequestedAt: requestedAt }, thread, runStatus);

  it("leaves threads without a goal to their run", () => {
    expect(resolve(null, "failed")).toEqual({
      status: "failed",
      attentionKey: "",
      holdsRunCompletion: false,
      completedGoalId: null,
      attentionTitle: null,
    });
  });

  it("holds run completions while the goal works, also over an old failed run", () => {
    expect(resolve(goal(), "failed")).toMatchObject({
      status: "working",
      holdsRunCompletion: true,
      attentionTitle: null,
    });
  });

  it.each([
    [{ needsInput: true }, "input", "Goal needs input"],
    [{ status: "blocked" }, "input", "Goal blocked"],
    [{ status: "paused", statusReason: "no_progress" }, "input", "Goal paused"],
    [{ status: "usageLimited" }, "limited", null],
  ] satisfies ReadonlyArray<[Partial<OrchestrationV2ThreadGoalSummary>, string, string | null]>)(
    "announces goal attention %j",
    (change, status, title) => {
      const result = resolve(goal(change));
      expect(result.status).toBe(status);
      expect(result.attentionTitle).toBe(title);
      expect(result.attentionKey).not.toBe(resolve(goal()).attentionKey);
    },
  );

  it("keeps a user pause quiet and lets owner approvals and questions speak", () => {
    expect(resolve(goal({ status: "paused", statusReason: "user" }), "failed").status).toBe(
      "ready",
    );
    expect(
      resolve(goal({ needsInput: true }), "approval", { ...idle, hasPendingApprovals: true }),
    ).toMatchObject({ status: "approval", attentionTitle: null });
    expect(
      resolve(goal({ needsInput: true }), "input", { ...idle, hasPendingUserInput: true }),
    ).toMatchObject({ status: "input", attentionTitle: null });
  });

  it("reports each completed goal and releases runs requested after it", () => {
    const done = goal({ status: "complete", updatedAt: "2026-09-13T09:30:00.000Z" });
    expect(resolve(done)).toMatchObject({ completedGoalId: "goal-1", holdsRunCompletion: true });
    expect(
      resolve(goal({ id: CommandId.make("goal-2"), status: "complete" })).completedGoalId,
    ).toBe("goal-2");
    expect(
      resolveThreadGoalNotification(
        { t3Goal: done, latestRunRequestedAt: DateTime.makeUnsafe("2026-09-13T09:45:00.000Z") },
        idle,
        "working",
      ),
    ).toMatchObject({ status: "working", holdsRunCompletion: false });
    expect(resolve(goal({ status: "stopped" })).holdsRunCompletion).toBe(false);
  });

  it("keeps the owner's old completion quiet once its goal stops", () => {
    vi.useFakeTimers();
    try {
      const { notify, observe } = harness();
      // The coordinator observes a goal-held completion as quiet, so it is handled.
      observe(working);
      observe(completed(1), { ...visible, quiet: true });
      observe(completed(1));
      vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
