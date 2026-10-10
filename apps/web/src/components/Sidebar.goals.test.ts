import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../test-fixtures";
import {
  filterSidebarV2VisibleThreads,
  groupGoalIterationsByGoalThread,
  nestedIterationLabel,
  resolveSidebarRouteOwnerKey,
  resolveSidebarThreadStatus,
  selectNestedGoalIterations,
  sidebarGoalStatusLabel,
} from "./Sidebar.logic";

const ownerId = ThreadId.make("owner");
const goalId = CommandId.make("goal");
const owner = makeThreadFixture({ id: ownerId });
const iteration = (number: number, environmentId = owner.environmentId) =>
  makeThreadFixture({
    id: ThreadId.make(`iteration-${number}`),
    environmentId,
    title: `Goal #${number}: Ship it`,
    goalIteration: { parentThreadId: ownerId, goalId, iteration: number },
  });
const summary = {
  id: goalId,
  objective: "Ship",
  status: "active" as const,
  statusReason: null,
  iteration: 4,
  tokensUsed: 0,
  needsInput: false,
  currentChildThreadId: null,
};

describe("goal sidebar ownership", () => {
  it("nests children under reachable owners, retaining orphans and scoped children", () => {
    const child = iteration(1);
    expect(filterSidebarV2VisibleThreads([owner, child], null).map((thread) => thread.id)).toEqual([
      ownerId,
    ]);
    expect(filterSidebarV2VisibleThreads([child], null)).toEqual([child]);
    expect(
      filterSidebarV2VisibleThreads([{ ...owner, archivedAt: owner.createdAt }, child], null),
    ).toEqual([child]);
    const remoteChild = iteration(1, EnvironmentId.make("remote"));
    expect(filterSidebarV2VisibleThreads([owner, remoteChild], null)).toEqual([owner, remoteChild]);
    expect(filterSidebarV2VisibleThreads([owner, child], new Set())).toEqual([]);
  });

  it("groups within each environment, ignores archived children and prioritizes the current iteration", () => {
    const children = [iteration(1), iteration(3), iteration(2)];
    const remote = iteration(2, EnvironmentId.make("remote"));
    const groups = groupGoalIterationsByGoalThread([
      owner,
      ...children,
      remote,
      { ...iteration(4), archivedAt: owner.createdAt },
    ]);
    const group = groups.get(`${owner.environmentId}:${ownerId}`)!;
    expect(group.map((thread) => thread.goalIteration?.iteration)).toEqual([3, 2, 1]);
    expect(groups.size).toBe(2);
    expect(
      selectNestedGoalIterations(group, children[0]!.id, 2).map(
        (thread) => thread.goalIteration?.iteration,
      ),
    ).toEqual([1, 3]);
    expect(nestedIterationLabel(children[1]!)).toBe("#3 Ship it");
  });

  it("reveals a parked owner for deep links to old iterations after the goal was cleared", () => {
    const child = iteration(1);
    const route = `${child.environmentId}:${child.id}`;
    expect(resolveSidebarRouteOwnerKey([owner, child], route)).toBe(
      `${owner.environmentId}:${owner.id}`,
    );
    expect(resolveSidebarRouteOwnerKey([child], route)).toBe(route);
    expect(
      resolveSidebarRouteOwnerKey([{ ...owner, archivedAt: owner.createdAt }, child], route),
    ).toBe(route);
    expect(resolveSidebarRouteOwnerKey([owner, child], null)).toBeNull();
  });
});

describe("T3 goal status without native-goal collision", () => {
  it("surfaces iteration input, usage backoff and agent pauses on the owner", () => {
    expect(resolveSidebarThreadStatus({ ...owner, t3Goal: summary })).toBe("working");
    expect(resolveSidebarThreadStatus({ ...owner, t3Goal: { ...summary, needsInput: true } })).toBe(
      "input",
    );
    expect(
      resolveSidebarThreadStatus({ ...owner, t3Goal: { ...summary, status: "blocked" } }),
    ).toBe("input");
    expect(
      resolveSidebarThreadStatus({
        ...owner,
        t3Goal: { ...summary, status: "paused", statusReason: "no_progress" },
      }),
    ).toBe("input");
    expect(
      resolveSidebarThreadStatus({
        ...owner,
        t3Goal: { ...summary, status: "paused", statusReason: "user" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarThreadStatus({ ...owner, t3Goal: { ...summary, status: "usageLimited" } }),
    ).toBe("limited");
    expect(
      resolveSidebarThreadStatus({ ...owner, hasPendingApprovals: true, t3Goal: summary }),
    ).toBe("approval");
    const nativeOwner = {
      ...owner,
      goal: { objective: "Native", status: "active" as const, tokensUsed: null },
    };
    expect(resolveSidebarThreadStatus(nativeOwner)).toBe("ready");
  });
  it("names the iteration and reason for attention", () => {
    expect(sidebarGoalStatusLabel(summary, "working")).toBe("Iteration 4");
    expect(sidebarGoalStatusLabel({ ...summary, status: "blocked" }, "input")).toBe("Blocked");
    expect(sidebarGoalStatusLabel({ ...summary, needsInput: true }, "input")).toBe("Input");
    expect(sidebarGoalStatusLabel({ ...summary, status: "complete" }, "ready")).toBeNull();
  });
});
