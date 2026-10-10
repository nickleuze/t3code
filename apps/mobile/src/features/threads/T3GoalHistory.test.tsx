// @vitest-environment jsdom
import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { makeThreadShellFixture } from "../../test-fixtures";
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState?: { expanded?: boolean; selected?: boolean };
  }) => (
    <button
      aria-label={accessibilityLabel}
      aria-expanded={accessibilityState?.expanded}
      aria-pressed={accessibilityState?.selected}
      onClick={onPress}
    >
      {children}
    </button>
  ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
import { T3GoalHistory } from "./T3GoalHistory";
const env = EnvironmentId.make("remote-host");
const owner = makeThreadShellFixture({
  environmentId: env,
  id: ThreadId.make("owner"),
  title: "Ship",
});
const iterations = Array.from({ length: 15 }, (_, index) =>
  makeThreadShellFixture({
    environmentId: env,
    id: ThreadId.make(`iteration-${15 - index}`),
    title: `Goal #${15 - index}: Fix`,
    goalIteration: {
      goalId: CommandId.make("goal"),
      parentThreadId: owner.id,
      iteration: 15 - index,
    },
  }),
);
let root: Root;
let container: HTMLDivElement;
const select = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  select.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const click = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
it("opens, pages and folds history, with the running iteration first and scoped navigation", async () => {
  const running = iterations[10]!;
  await act(async () =>
    root.render(
      <T3GoalHistory
        owner={{
          ...owner,
          t3Goal: {
            id: CommandId.make("goal"),
            objective: "Ship",
            status: "active",
            statusReason: null,
            iteration: 5,
            tokensUsed: 0,
            needsInput: false,
            currentChildThreadId: running.id,
          },
        }}
        iterations={iterations}
        onSelectThread={select}
      />,
    ),
  );
  expect(container.querySelectorAll("button")).toHaveLength(4);
  await click("Show goal iterations for Ship");
  expect([...container.querySelectorAll("button")][1]?.textContent).toContain("#5");
  await click(`Open goal iteration 5: ${running.title}`);
  expect(select).toHaveBeenCalledExactlyOnceWith(running);
  expect(select.mock.calls[0]![0].environmentId).toBe(env);
  await click("Show more goal iterations");
  expect(container.querySelectorAll("button")).toHaveLength(16);
  await click("Hide goal iterations for Ship");
  expect(container.querySelectorAll("button")).toHaveLength(4);
});
it("keeps the selected old iteration reachable while folded and beyond the page limit", async () => {
  const selected = iterations.at(-1)!;
  await act(async () =>
    root.render(
      <T3GoalHistory
        owner={owner}
        iterations={iterations}
        parked
        selectedThreadKey={`${env}:${selected.id}`}
        onSelectThread={select}
      />,
    ),
  );
  await click(`Open goal iteration 1: ${selected.title}`);
  expect(select).toHaveBeenCalledExactlyOnceWith(selected);
  await click("Show goal iterations for Ship");
  expect(container.textContent).toContain("#1 Fix");
  await click("Hide goal iterations for Ship");
  expect(container.querySelectorAll("button")).toHaveLength(2);
});
it("does not select a same-ID iteration from another environment", async () => {
  await act(async () =>
    root.render(
      <T3GoalHistory
        owner={owner}
        iterations={iterations}
        parked
        selectedThreadKey={`elsewhere:${iterations[0]!.id}`}
        onSelectThread={select}
      />,
    ),
  );
  expect(container.querySelectorAll("button")).toHaveLength(1);
});
