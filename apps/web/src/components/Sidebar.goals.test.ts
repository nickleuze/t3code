import { CommandId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../test-fixtures";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";

const ownerId = ThreadId.make("owner");
const goalId = CommandId.make("goal");
const owner = makeThreadFixture({ id: ownerId });
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
});
