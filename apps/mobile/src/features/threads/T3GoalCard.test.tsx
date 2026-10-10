// @vitest-environment jsdom
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2GoalProposal,
  type OrchestrationV2ThreadGoalSummary,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  canMutate: true,
  projection: null as unknown,
  set: vi.fn(),
  control: vi.fn(),
  dismiss: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => fixture.canMutate }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: fixture.navigate }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: "ios" },
  KeyboardAvoidingView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    editable,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    editable: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      disabled={!editable}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      onChange={() => {}}
    />
  ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children: React.ReactNode;
    accessibilityRole?: string;
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("./RequestActionButton", () => ({
  RequestActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    setGoal: { permissionAtom: () => null },
    controlGoal: "control",
    dismissGoalProposal: "dismiss",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "control" ? fixture.control : command === "dismiss" ? fixture.dismiss : fixture.set,
}));
vi.mock("../../state/use-thread-detail", () => ({ useThreadProjection: () => fixture.projection }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "command" }));

import { T3GoalCard } from "./T3GoalCard";
const proposal: OrchestrationV2GoalProposal = {
  id: CommandId.make("proposal"),
  objective: "Ship",
  doneWhen: "Checks pass",
  background: "Use the isolated candidate",
  permissions: "Local edits",
  checkCommand: "test",
  iterationTimeoutMins: 30,
  reason: null,
  proposedAt: "2026-01-01T00:00:00Z",
};
const goal: OrchestrationV2ThreadGoalSummary = {
  id: CommandId.make("goal"),
  objective: "Ship",
  status: "active",
  statusReason: null,
  iteration: 3,
  tokensUsed: 0,
  needsInput: true,
  currentChildThreadId: ThreadId.make("iteration"),
};
const shell = {
  environmentId: EnvironmentId.make("remote-host"),
  id: ThreadId.make("owner"),
  lineage: { relationshipToParent: null },
  goalProposal: proposal,
} as EnvironmentThreadShell;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  fixture.canMutate = true;
  fixture.projection = null;
  fixture.set.mockReset().mockResolvedValue({ _tag: "Success" });
  fixture.control.mockReset().mockResolvedValue({ _tag: "Success" });
  fixture.dismiss.mockReset().mockResolvedValue({ _tag: "Success" });
  fixture.navigate.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
async function render(thread = shell, supportsGoals = true) {
  await act(async () => root.render(<T3GoalCard thread={thread} supportsGoals={supportsGoals} />));
}
function button(label: string) {
  const node = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
it("waits for the user to Start and suppresses repeat Start through acknowledgement", async () => {
  let finish!: () => void;
  fixture.set.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ _tag: "Success" });
      }),
  );
  await render();
  expect(fixture.set).not.toHaveBeenCalled();
  const start = button("Start goal");
  await act(async () => {
    start.click();
    start.click();
  });
  expect(fixture.set).toHaveBeenCalledTimes(1);
  expect(fixture.set.mock.calls[0]![0]).toMatchObject({
    environmentId: "remote-host",
    input: {
      type: "thread.goal.set",
      threadId: "owner",
      objective: "Ship",
      doneWhen: "Checks pass",
      background: proposal.background,
      permissions: proposal.permissions,
      checkCommand: "test",
      iterationTimeoutMins: 30,
    },
  });
  await act(async () => finish());
  await act(async () => button("Start goal").click());
  expect(fixture.set).toHaveBeenCalledTimes(1);
});
it("allows retry after refusal and honors revoked permission", async () => {
  fixture.set.mockRejectedValueOnce(new Error("Server refused"));
  await render();
  await act(async () => button("Start goal").click());
  expect(container.textContent).toContain("Server refused");
  await act(async () => button("Start goal").click());
  expect(fixture.set).toHaveBeenCalledTimes(2);
  fixture.canMutate = false;
  await render();
  await act(async () => button("Dismiss").click());
  expect(fixture.dismiss).not.toHaveBeenCalled();
});
it("does not offer Start in a subagent or iteration and hides unsupported hosts", async () => {
  await render({ ...shell, lineage: { ...shell.lineage, relationshipToParent: "subagent" } });
  expect(button("Start goal").disabled).toBe(true);
  await render({
    ...shell,
    goalIteration: { goalId: goal.id, parentThreadId: shell.id, iteration: 1 },
  });
  expect(button("Start goal").disabled).toBe(true);
  await render(shell, false);
  expect(container.textContent).toBe("");
  expect(fixture.set).not.toHaveBeenCalled();
});
it("opens a waiting iteration on its owning environment and stops the owner goal", async () => {
  await render({ ...shell, t3Goal: goal });
  await act(async () => button("Answer iteration").click());
  expect(fixture.navigate).toHaveBeenCalledWith("Thread", {
    environmentId: "remote-host",
    threadId: "iteration",
  });
  await act(async () => button("Stop").click());
  expect(fixture.control).toHaveBeenCalledWith({
    environmentId: shell.environmentId,
    input: {
      type: "thread.goal.control",
      commandId: "command",
      threadId: "owner",
      goalId: "goal",
      action: "stop",
    },
  });
});
it("withholds Clear while the last iteration is winding down", async () => {
  await render({ ...shell, goalProposal: null, t3Goal: { ...goal, status: "stopped" } });
  expect(
    Array.from(container.querySelectorAll("button")).some((node) => node.textContent === "Clear"),
  ).toBe(false);
  await render({
    ...shell,
    goalProposal: null,
    t3Goal: { ...goal, status: "stopped", currentChildThreadId: null },
  });
  await act(async () => button("Clear").click());
  expect(fixture.control.mock.calls[0]![0].input.action).toBe("clear");
});
it("dismisses a proposal without starting work and returns from an iteration to its owner", async () => {
  await render();
  await act(async () => button("Dismiss").click());
  expect(fixture.dismiss.mock.calls[0]![0].input).toMatchObject({
    type: "thread.goal.proposal.dismiss",
    proposalId: proposal.id,
  });
  expect(fixture.set).not.toHaveBeenCalled();
  await render({
    ...shell,
    goalProposal: null,
    goalIteration: { goalId: goal.id, parentThreadId: ThreadId.make("goal-owner"), iteration: 2 },
  });
  await act(async () => button("Open goal").click());
  expect(fixture.navigate).toHaveBeenCalledWith("Thread", {
    environmentId: "remote-host",
    threadId: "goal-owner",
  });
});

async function change(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("edits a proposal without starting, validates limits and submits the edited brief", async () => {
  await render();
  await act(async () => button("Edit").click());
  expect(fixture.set).not.toHaveBeenCalled();
  await change("Objective", "Edited objective");
  await change("Done when", "All local checks pass");
  await change("Minutes per iteration (15–480)", "0");
  const start = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(
      (node) => node.textContent === "Start goal",
    )!;
  expect(start().disabled).toBe(true);
  await change("Minutes per iteration (15–480)", "45");
  await change("Max usage rise (%)", "15");
  await change("Burn guard window (minutes)", "30");
  await change("Idle iterations before pausing (1–20)", "4");
  await act(async () => start().click());
  expect(fixture.set).toHaveBeenCalledTimes(1);
  expect(fixture.set.mock.calls[0]![0].input).toMatchObject({
    objective: "Edited objective",
    doneWhen: "All local checks pass",
    iterationTimeoutMins: 45,
    burnGuard: { maxPercentPoints: 15, windowMins: 30 },
    noProgressLimit: 4,
  });
});
it("exposes historical iterations and progress without starting provider work", async () => {
  fixture.projection = {
    projection: {
      thread: {
        goal: {
          ...goal,
          usageAccounting: "unavailable",
          progressNotes: [{ iteration: 2, at: "now", text: "The check failed" }],
          lastCheck: { passed: false, command: "test", outputTail: "Assertion failed" },
          history: [{ iteration: 2, childThreadId: "old-iteration", outcome: "check_failed" }],
          current: null,
        },
      },
    },
  };
  await render({ ...shell, t3Goal: goal });
  await act(async () => button("Goal details").click());
  expect(container.textContent).toContain("The check failed");
  expect(container.textContent).toContain("Assertion failed");
  expect(container.textContent).toContain("Token usage not reported");
  await act(async () => button("Iteration 2: Check failed").click());
  expect(fixture.navigate).toHaveBeenCalledWith("Thread", {
    environmentId: "remote-host",
    threadId: "old-iteration",
  });
  expect(fixture.set).not.toHaveBeenCalled();
});
