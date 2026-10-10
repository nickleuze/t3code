import { CommandId, ThreadId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarGoalIterations } from "./SidebarGoalIterations";

const iterations = [4, 3, 2, 1].map((number) =>
  makeThreadFixture({
    id: ThreadId.make(`iteration-${number}`),
    title: `Goal #${number}: Ship`,
    goalIteration: {
      parentThreadId: ThreadId.make("owner"),
      goalId: CommandId.make("goal"),
      iteration: number,
    },
  }),
);
let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

it("unfolds stopped goal history and navigates to the selected iteration", async () => {
  const onOpen = vi.fn();
  await act(async () => {
    renderer = create(
      <SidebarGoalIterations
        goal={null}
        iterations={iterations}
        parked
        activeRouteThreadKey={null}
        onOpen={onOpen}
      />,
    );
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(1);
  expect(onOpen).not.toHaveBeenCalled();
  await act(async () => {
    renderer.root.findAllByType("button")[0]!.props.onClick();
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(5);
  await act(async () => {
    renderer.root.findAllByType("button")[4]!.props.onClick();
  });
  expect(onOpen).toHaveBeenCalledExactlyOnceWith({
    environmentId: iterations[3]!.environmentId,
    threadId: iterations[3]!.id,
  });
  await act(async () => {
    renderer.root.findAllByType("button")[0]!.props.onClick();
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(1);
});

it("keeps an old routed iteration visible even when its owner is parked", async () => {
  const selected = iterations[3]!;
  const props = {
    goal: null,
    iterations,
    parked: true,
    activeRouteThreadKey: `${selected.environmentId}:${selected.id}`,
    onOpen: vi.fn(),
  };
  await act(async () => {
    renderer = create(<SidebarGoalIterations {...props} />);
  });
  expect(renderer.root.findByProps({ "aria-current": "page" }).children).toContainEqual(
    expect.objectContaining({ type: "span" }),
  );
  expect(renderer.root.findAllByType("button")).toHaveLength(2);
  await act(async () => {
    renderer.update(<SidebarGoalIterations {...props} activeRouteThreadKey={null} />);
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(1);
});

it("shows the current iteration of a parked active goal before older history", async () => {
  const goal = {
    id: CommandId.make("goal"),
    objective: "Ship",
    status: "active" as const,
    statusReason: null,
    iteration: 4,
    tokensUsed: 0,
    needsInput: true,
    currentChildThreadId: iterations[3]!.id,
  };
  await act(async () => {
    renderer = create(
      <SidebarGoalIterations
        goal={goal}
        iterations={iterations}
        parked
        activeRouteThreadKey={null}
        onOpen={vi.fn()}
      />,
    );
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(2);
  expect(
    renderer.root
      .findAllByType("button")[1]!
      .findAllByType("span")
      .map((span) => span.children.join("")),
  ).toEqual(["#1 Ship", "Input"]);
});
