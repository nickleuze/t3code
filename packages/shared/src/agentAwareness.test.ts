import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  ThreadId,
} from "@t3tools/contracts";
import { CommandId, ProviderInstanceId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { projectThreadAwarenessV2 } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<Project, "title">;

describe("projectThreadAwarenessV2", () => {
  const updatedAt = DateTime.makeUnsafe(NOW);
  const v2Thread = (
    overrides: Partial<
      Pick<
        OrchestrationV2ThreadShell,
        | "activityRunStatus"
        | "status"
        | "pendingBackgroundTasks"
        | "pendingRuntimeRequest"
        | "lineage"
        | "t3Goal"
        | "goalIteration"
        | "latestRunRequestedAt"
      >
    > = {},
  ) => ({
    id: "thread-2" as ThreadId,
    lineage: {
      rootThreadId: "thread-2" as ThreadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    title: "Integrate orchestration",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    status: "running" as const,
    pendingRuntimeRequest: null,
    latestRunRequestedAt: null,
    updatedAt,
    ...overrides,
  });

  it("projects V2 run state", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread(),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each(["running", "completed", "failed"] as const)(
    "does not publish %s subagent activity",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status,
            lineage: {
              rootThreadId: "parent" as ThreadId,
              parentThreadId: "parent" as ThreadId,
              relationshipToParent: "subagent",
            },
          }),
        }),
      ).toBeNull();
    },
  );

  it("keeps an older activity run visible over a newer cancelled run", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "cancelled", activityRunStatus: "running" }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each([
    ["only a dev server", "completed", [{ taskId: "dev", kind: "command" }]],
    ["a monitor", "running", [{ taskId: "watch", kind: "monitor" }]],
    [
      "a dev server and a subagent",
      "running",
      [
        { taskId: "dev", kind: "command" },
        { taskId: "review", kind: "subagent" },
      ],
    ],
  ] as const)("reports a completed run waiting on %s as %s", (_case, phase, tasks) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed", pendingBackgroundTasks: tasks }),
      }),
    ).toMatchObject({ phase });
  });

  it("prioritizes V2 user-input requests", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-1"),
            kind: "user_input",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "waiting_for_input", headline: "Waiting for input" });
  });

  it("does not present authentication refreshes as user approvals", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-auth-refresh"),
            kind: "auth_refresh",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  const goal = {
    id: CommandId.make("goal-1"),
    objective: "Complete the integration",
    status: "active" as const,
    statusReason: null,
    iteration: 3,
    tokensUsed: 0,
    needsInput: false,
    currentChildThreadId: "iteration-3" as ThreadId,
    updatedAt: "2026-05-22T11:59:00.000Z",
  };

  it.each([
    [{}, "running", "Goal is working"],
    [{ needsInput: true }, "waiting_for_input", "Goal needs input"],
    [{ status: "blocked" }, "waiting_for_input", "Goal blocked"],
    [{ status: "paused", statusReason: "no_progress" }, "waiting_for_input", "Goal paused"],
    [{ status: "usageLimited" }, "waiting_for_input", "Usage limit reached"],
    [{ status: "complete" }, "completed", "Goal complete"],
  ] satisfies ReadonlyArray<
    [Partial<NonNullable<OrchestrationV2ThreadShell["t3Goal"]>>, string, string]
  >)("projects owner goal %j independently of an old failed run", (change, phase, headline) => {
    const state = projectThreadAwarenessV2({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({ status: "failed", t3Goal: { ...goal, ...change } }),
    });
    expect(state).toMatchObject({ phase, headline, updatedAt: goal.updatedAt });
    expect(state?.deepLink).toBe("/threads/env-1/thread-2");
    // Neither objective nor report text is included in activity detail.
    expect(state?.detail ?? "").not.toContain(goal.objective);
  });

  it("keeps user-paused goals quiet and restores ordinary activity after Stop", () => {
    const input = { environmentId: "env-1" as EnvironmentId, project };
    expect(
      projectThreadAwarenessV2({
        ...input,
        thread: v2Thread({
          status: "completed",
          t3Goal: { ...goal, status: "paused", statusReason: "user" },
        }),
      }),
    ).toBeNull();
    expect(
      projectThreadAwarenessV2({
        ...input,
        thread: v2Thread({
          t3Goal: { ...goal, status: "stopped", statusReason: "user" },
        }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working", updatedAt: NOW });
  });

  it.each(["user_input", "command"] as const)("prioritizes owner %s requests", (kind) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          t3Goal: goal,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-goal"),
            kind,
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject(
      kind === "command"
        ? { phase: "waiting_for_approval", headline: "Approval needed" }
        : { phase: "waiting_for_input", headline: "Waiting for input" },
    );
  });

  it.each(["running", "completed", "failed"] as const)(
    "keeps top-level %s goal iterations silent",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status,
            goalIteration: {
              parentThreadId: "owner" as ThreadId,
              goalId: goal.id,
              iteration: 3,
            },
          }),
        }),
      ).toBeNull();
    },
  );

  it("accepts old goal summaries without a transition timestamp", () => {
    const { updatedAt: _updatedAt, ...oldGoal } = goal;
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ t3Goal: oldGoal }),
      }),
    ).toMatchObject({ phase: "running", updatedAt: NOW });
  });

  it("returns to ordinary run activity after a completed goal", () => {
    const input = { environmentId: "env-1" as EnvironmentId, project };
    for (const status of ["running", "completed", "failed"] as const) {
      expect(
        projectThreadAwarenessV2({
          ...input,
          thread: v2Thread({
            status,
            t3Goal: { ...goal, status: "complete" },
            latestRunRequestedAt: updatedAt,
          }),
        }),
      ).toMatchObject({ phase: status, updatedAt: NOW });
    }
  });

  it("leaves provider-native goals independent of T3-owned goal activity", () => {
    const thread = {
      ...v2Thread({ status: "completed" }),
      goal: { objective: "Provider objective", status: "active", tokensUsed: 10 },
    };
    expect(
      projectThreadAwarenessV2({ environmentId: "env-1" as EnvironmentId, project, thread }),
    ).toMatchObject({ phase: "completed", headline: "Agent finished" });
  });
});
