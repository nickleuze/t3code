import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadGoalSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadShellFixture } from "../../test-fixtures";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  resolveThreadListV2Status,
  threadListV2ListItemsAreEqual,
} from "./threadListV2";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
const env = EnvironmentId.make("one");
const other = EnvironmentId.make("two");
const ownerId = ThreadId.make("owner");
const now = "2026-10-10T12:00:00Z";
const goal: OrchestrationV2ThreadGoalSummary = {
  id: CommandId.make("goal"),
  objective: "Ship",
  status: "active",
  statusReason: null,
  iteration: 4,
  needsInput: false,
  tokensUsed: 0,
  currentChildThreadId: ThreadId.make("iteration-4"),
};
const owner = makeThreadShellFixture({ environmentId: env, id: ownerId, title: "Ship" });
const iteration = (number: number, patch: Partial<EnvironmentThreadShell> = {}) =>
  makeThreadShellFixture({
    environmentId: env,
    id: ThreadId.make(`iteration-${number}`),
    title: `Goal #${number}: Fix parser`,
    goalIteration: { parentThreadId: ownerId, goalId: goal.id, iteration: number },
    ...patch,
  });
const build = (
  threads: readonly EnvironmentThreadShell[],
  patch: Partial<Parameters<typeof buildThreadListV2Items>[0]> = {},
) => buildThreadListV2Items({ threads, environmentId: null, searchQuery: "", now, ...patch });
const ids = (layout: ReturnType<typeof build>) => layout.items.map((item) => item.thread.id);

describe("mobile goal navigation", () => {
  it("nests newest iterations under their scoped owner and omits them from manual moves", () => {
    const threads = [iteration(1), owner, iteration(3), iteration(2)];
    const layout = build(threads);
    expect(ids(layout)).toEqual([ownerId]);
    expect(layout.items[0]?.goalIterations?.map((thread) => thread.id)).toEqual([
      "iteration-3",
      "iteration-2",
      "iteration-1",
    ]);
    expect(
      getThreadListV2OrderedSection({ threads, section: "active", now }).map((thread) => thread.id),
    ).toEqual([ownerId]);
  });
  it("retains orphan and archived-owner iterations as ordinary reachable rows", () => {
    expect(ids(build([iteration(1)]))).toEqual(["iteration-1"]);
    expect(ids(build([{ ...owner, archivedAt: now }, iteration(1)]))).toEqual(["iteration-1"]);
  });
  it("does not hide an iteration under the same owner ID in a different environment", () => {
    expect(ids(build([{ ...owner, environmentId: other }, iteration(1)]))).toContain("iteration-1");
  });
  it("keeps an iteration visible when its owner is outside the selected project scope", () => {
    const child = iteration(1, { projectId: ProjectId.make("different") });
    expect(
      ids(
        build([owner, child], {
          projectRefs: [{ environmentId: env, projectId: child.projectId }],
        }),
      ),
    ).toEqual([child.id]);
  });
  it("reveals a selected iteration's owner beyond collapsed settled paging", () => {
    const parked = {
      ...owner,
      settledOverride: "settled" as const,
      settledAt: "2025-01-01T00:00:00Z",
    };
    const recent = makeThreadShellFixture({
      environmentId: env,
      id: ThreadId.make("recent"),
      settledOverride: "settled",
      settledAt: now,
    });
    expect(
      ids(
        build([recent, parked, iteration(1)], {
          selectedThreadKey: `${env}:iteration-1`,
          settledShelfExpanded: false,
          settledLimit: 1,
        }),
      ),
    ).toEqual([ownerId]);
  });
  it("reveals a selected iteration's snoozed or working owner on a collapsed shelf", () => {
    expect(
      ids(
        build([{ ...owner, snoozedUntil: "2027-01-01T00:00:00Z", snoozedAt: now }, iteration(1)], {
          selectedThreadKey: `${env}:iteration-1`,
          snoozedShelfExpanded: false,
        }),
      ),
    ).toEqual([ownerId]);
    expect(
      ids(
        build([{ ...owner, t3Goal: goal }, iteration(1)], {
          selectedThreadKey: `${env}:iteration-1`,
          workingShelfEnabled: true,
          workingShelfExpanded: false,
        }),
      ),
    ).toEqual([ownerId]);
  });
  it("finds a matching iteration through its owner without showing unrelated iterations", () => {
    const first = iteration(1, { title: "Find me" });
    const layout = build([owner, first, iteration(2)], { searchQuery: "find me" });
    expect(ids(layout)).toEqual([ownerId]);
    expect(layout.items[0]?.goalIterations).toEqual([first]);
  });
  it("keeps minute rebuilds equal but invalidates a changed nested iteration", () => {
    const threads = [owner, iteration(1)];
    const rows = (values: readonly EnvironmentThreadShell[]) =>
      buildThreadListV2ListItems({ items: build(values).items, pendingTasks: [] });
    const before = rows(threads)[0]!;
    expect(threadListV2ListItemsAreEqual(before, rows(threads)[0]!)).toBe(true);
    expect(
      threadListV2ListItemsAreEqual(
        before,
        rows([owner, { ...threads[1]!, title: "Changed" }])[0]!,
      ),
    ).toBe(false);
  });
});

describe("mobile goal status", () => {
  it.each([
    [{ ...goal }, "working"],
    [{ ...goal, needsInput: true }, "input"],
    [{ ...goal, status: "blocked" as const }, "input"],
    [{ ...goal, status: "paused" as const, statusReason: "no_progress" as const }, "input"],
    [{ ...goal, status: "paused" as const, statusReason: "user" as const }, "ready"],
    [{ ...goal, status: "usageLimited" as const }, "limited"],
    [{ ...goal, status: "complete" as const }, "ready"],
  ])("reflects the T3 loop without requiring an owner provider run", (t3Goal, expected) => {
    expect(resolveThreadListV2Status({ ...owner, t3Goal })).toBe(expected);
  });
  it("keeps approvals ahead of a goal's attention state", () => {
    expect(
      resolveThreadListV2Status({
        ...owner,
        hasPendingApprovals: true,
        t3Goal: { ...goal, needsInput: true },
      }),
    ).toBe("approval");
  });
});

it("uses saved activity order without lifecycle timestamps, while retaining manual arrangement", () => {
  const older = {
    ...owner,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2027-01-01T00:00:00Z",
    activeOrderKey: "b",
    latestUserMessageAt: "2026-01-02T00:00:00Z",
  };
  const newest = makeThreadShellFixture({
    environmentId: env,
    id: ThreadId.make("newest"),
    createdAt: "2026-01-01T00:00:00Z",
    activeOrderKey: "z",
    latestUserMessageAt: "2026-01-03T00:00:00Z",
  });
  expect(ids(build([older, newest], { flatThreadSortOrder: "manual" }))).toEqual([
    ownerId,
    newest.id,
  ]);
  expect(ids(build([older, newest], { flatThreadSortOrder: "last_activity" }))).toEqual([
    newest.id,
    ownerId,
  ]);
  expect(ids(build([older, newest], { flatThreadSortOrder: "updated_at" }))).toEqual([
    newest.id,
    ownerId,
  ]);
  expect(
    ids(
      build([{ ...older, createdAt: "2026-01-04T00:00:00Z" }, newest], {
        flatThreadSortOrder: "created_at",
      }),
    ),
  ).toEqual([ownerId, newest.id]);
});

it("keeps a goal needing input in the inbox despite owner background work", () => {
  const waiting = {
    ...owner,
    t3Goal: { ...goal, needsInput: true },
    runtime: {
      status: "idle" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access" as const,
      activeRunId: null,
      lastError: null,
      updatedAt: now,
    },
  };
  const layout = build([waiting], { workingShelfEnabled: true, workingShelfExpanded: false });
  expect(ids(layout)).toEqual([ownerId]);
  expect(layout.workingCount).toBe(0);
});
