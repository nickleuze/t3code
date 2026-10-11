import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadGoalSummary,
} from "@t3tools/contracts";
import { useEffect, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
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
let renderer: ReactTestRenderer;
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
      {result.bannerItems.map((item) => (
        <div key={item.id}>{item.actions as ReactNode}</div>
      ))}
      {result.dialog}
    </>
  );
}
async function render(t3Goal: OrchestrationV2ThreadGoalSummary) {
  await act(async () => {
    if (renderer) renderer.update(<Probe thread={thread(t3Goal)} />);
    else renderer = create(<Probe thread={thread(t3Goal)} />);
  });
}
const buttons = () => renderer.root.findAllByType("button").map((node) => node.props.children);

beforeEach(() => {
  fixture.message.mockReset().mockResolvedValue({ _tag: "Success" });
  fixture.update.mockReset().mockResolvedValue({ _tag: "Success" });
  fixture.projection = null;
  fixture.dialog = null;
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  renderer = undefined as unknown as ReactTestRenderer;
});

it("routes live-goal sends to the goal and drops a second Enter while the reply is in flight", async () => {
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
          checkCommand: null,
          iterationTimeoutMins: 120,
        },
      },
    },
  };
  await render(goal);
  const edit = renderer.root.findAllByType("button").find((node) => node.props.children === "Edit");
  await act(async () => edit!.props.onClick());
  expect(fixture.dialog?.mode).toBe("edit");
  await act(async () =>
    fixture.dialog!.onSubmit({
      objective: "Ship",
      doneWhen: "CI passes",
      background: null,
      permissions: "Local edits, merge after CI",
      checkCommand: "ignored",
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
