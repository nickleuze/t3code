import { CommandId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
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
const buttons = (container: HTMLElement) => [...container.querySelectorAll("button")];

it("unfolds stopped goal history and navigates to the selected iteration", async () => {
  const onOpen = vi.fn();
  await using screen = await render(
    <SidebarGoalIterations
      goal={null}
      iterations={iterations}
      parked
      activeRouteThreadKey={null}
      onOpen={onOpen}
    />,
  );
  expect(buttons(screen.container)).toHaveLength(1);
  await userEvent.click(buttons(screen.container)[0]!);
  expect(buttons(screen.container)).toHaveLength(5);
  await userEvent.click(buttons(screen.container)[4]!);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith({
    environmentId: iterations[3]!.environmentId,
    threadId: iterations[3]!.id,
  });
  await userEvent.click(buttons(screen.container)[0]!);
  expect(buttons(screen.container)).toHaveLength(1);
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
  await using screen = await render(<SidebarGoalIterations {...props} />);
  expect(screen.container.querySelector('[aria-current="page"]')).not.toBeNull();
  expect(buttons(screen.container)).toHaveLength(2);
  await screen.rerender(<SidebarGoalIterations {...props} activeRouteThreadKey={null} />);
  expect(buttons(screen.container)).toHaveLength(1);
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
  await using screen = await render(
    <SidebarGoalIterations
      goal={goal}
      iterations={iterations}
      parked
      activeRouteThreadKey={null}
      onOpen={vi.fn()}
    />,
  );
  const rows = buttons(screen.container);
  expect(rows).toHaveLength(2);
  expect([...rows[1]!.querySelectorAll("span")].map((span) => span.textContent)).toEqual([
    "#1 Ship",
    "Input",
  ]);
});
