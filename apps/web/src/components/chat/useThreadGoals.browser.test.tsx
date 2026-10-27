import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadGoalSummary,
} from "@t3tools/contracts";
import { useEffect, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render as renderUi, type Screen } from "../../../test/render";

import type { GoalBrief } from "./GoalDialog";
import { useThreadGoals } from "./useThreadGoals";

const fixture = vi.hoisted(() => ({
  message: vi.fn(),
  update: vi.fn(),
  other: vi.fn(),
  projection: null as unknown,
  dialog: null as null | { mode: string; onSubmit: (brief: GoalBrief) => Promise<void> },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/lib/utils", () => ({ randomUUID: () => "command" }));
vi.mock("../../state/entities", () => ({ useThreadProjection: () => fixture.projection }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { messageGoal: "message", updateGoal: "update" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "message" ? fixture.message : command === "update" ? fixture.update : fixture.other,
}));
vi.mock("../../threadRoutes", () => ({ buildThreadRouteParams: () => ({}) }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (x: unknown) => x,
}));
vi.mock("./GoalDialog", () => ({
  GoalDialog: (props: NonNullable<typeof fixture.dialog>) => {
    fixture.dialog = props;
    return null;
  },
}));

const environmentId = EnvironmentId.make("env");
const goal: OrchestrationV2ThreadGoalSummary = {
  id: CommandId.make("goal"),
  objective: "Ship",
  status: "paused",
  statusReason: "agent",
  iteration: 2,
  tokensUsed: 0,
  needsInput: false,
  currentChildThreadId: null,
};
const thread = (t3Goal: OrchestrationV2ThreadGoalSummary) =>
  ({
    id: ThreadId.make("owner"),
    runtimeMode: "full-access",
    t3Goal,
    goalProposal: null,
    goalIteration: null,
  }) as unknown as EnvironmentThreadShell;

let hook: ReturnType<typeof useThreadGoals>;
let screen: Screen | undefined;
function Probe(props: { readonly thread: EnvironmentThreadShell }) {
  const result = useThreadGoals({
    environmentId,
    thread: props.thread,
    supportsGoals: true,
    isServerThread: true,
    isSubagent: false,
  });
  useEffect(() => {
    hook = result;
  });
  return (
    <>
      {result.nowItem ? <div>{result.nowItem.actions}</div> : null}
      {result.bannerItems.map((item) => (
        <div key={item.id}>{item.actions as ReactNode}</div>
      ))}
      {result.dialog}
    </>
  );
}
async function render(t3Goal: OrchestrationV2ThreadGoalSummary) {
  if (screen) await screen.rerender(<Probe thread={thread(t3Goal)} />);
  else screen = await renderUi(<Probe thread={thread(t3Goal)} />, { router: false });
}
const buttonElements = () => [...(screen?.container.querySelectorAll("button") ?? [])];
const buttons = () => buttonElements().map((node) => node.textContent);

/** Resets the fixtures; disposing it unmounts whatever the test rendered. */
function setup(): AsyncDisposable {
  fixture.message.mockReset().mockResolvedValue({ _tag: "Success" });
  fixture.update.mockReset().mockResolvedValue({ _tag: "Success" });
  fixture.projection = null;
  fixture.dialog = null;
  return {
    async [Symbol.asyncDispose]() {
      await screen?.[Symbol.asyncDispose]();
      screen = undefined;
    },
  };
}

it("routes live-goal sends to the goal and drops a second Enter while the reply is in flight", async () => {
  await using _setup = setup();
  await render({ ...goal, status: "active", currentChildThreadId: ThreadId.make("child") });
  const route = hook.routeSend("  keep the candidate ", false);
  expect(route).toEqual({ kind: "reply", goalId: goal.id, text: "keep the candidate" });
  if (route.kind !== "reply") throw new Error("expected a reply");
  let finish!: () => void;
  fixture.message.mockReturnValue(
    new Promise((resolve) => {
      finish = () => resolve({ _tag: "Success" });
    }),
  );
  const first = hook.sendReply(route);
  expect(await hook.sendReply(route)).toBe(false);
  finish();
  expect(await first).toBe(true);
  expect(fixture.message).toHaveBeenCalledTimes(1);
  expect(hook.routeSend("hello", true)).toEqual({ kind: "handled" });
});

it("edits a paused goal's brief through thread.goal.update and offers no edit while it runs", async () => {
  await using _setup = setup();
  await render({ ...goal, status: "active" });
  expect(buttons()).not.toContain("Edit");
  fixture.projection = {
    projection: {
      thread: {
        goal: {
          ...goal,
          doneWhen: "CI passes",
          background: null,
          permissions: "Local edits",
          iterationTimeoutMins: 120,
        },
      },
    },
  };
  await render(goal);
  const edit = buttonElements().find((node) => node.textContent === "Edit");
  await act(() => edit!.click());
  expect(fixture.dialog?.mode).toBe("edit");
  await act(async () =>
    fixture.dialog!.onSubmit({
      objective: "Ship",
      doneWhen: "CI passes",
      background: null,
      permissions: "Local edits, merge after CI",
      iterationTimeoutMins: 45,
    }),
  );
  expect(fixture.update).toHaveBeenCalledWith({
    environmentId,
    input: {
      type: "thread.goal.update",
      commandId: "command",
      threadId: "owner",
      goalId: "goal",
      objective: "Ship",
      doneWhen: "CI passes",
      background: null,
      permissions: "Local edits, merge after CI",
    },
  });
});
