import { CommandId, type OrchestrationV2GoalProposal } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { goalProposalBannerItem } from "./GoalBanner";

const proposal = {
  id: CommandId.make("proposal"),
  objective: "Ship",
  doneWhen: "Tests pass",
  reason: null,
} as OrchestrationV2GoalProposal;
const startButton = (container: HTMLElement) => container.querySelectorAll("button")[0]!;

it("does no work until Start and suppresses repeat Start while awaiting acknowledgement", async () => {
  let finish!: () => void;
  const start = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const banner = goalProposalBannerItem({
    proposal,
    canStart: true,
    canDismiss: true,
    onStart: start,
    onEdit: vi.fn(),
    onDismiss: vi.fn(),
  });
  await using screen = await render(<>{banner.actions}</>);
  expect(start).not.toHaveBeenCalled();
  await act(() => {
    startButton(screen.container).click();
    startButton(screen.container).click();
  });
  expect(start).toHaveBeenCalledTimes(1);
  await act(() => finish());
  await act(() => startButton(screen.container).click());
  expect(start).toHaveBeenCalledTimes(1);
});

it("allows retry after a rejected Start and denies Start without permission", async () => {
  const start = vi.fn().mockRejectedValueOnce(new Error("Rejected")).mockResolvedValue(undefined);
  const props = {
    proposal,
    canStart: true,
    canDismiss: true,
    onStart: start,
    onEdit: vi.fn(),
    onDismiss: vi.fn(),
  };
  await using screen = await render(<>{goalProposalBannerItem(props).actions}</>);
  await act(() => startButton(screen.container).click());
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toBe("Rejected"),
  );
  await act(() => startButton(screen.container).click());
  expect(start).toHaveBeenCalledTimes(2);
  await screen.rerender(
    <>{goalProposalBannerItem({ ...props, canStart: false, canDismiss: false }).actions}</>,
  );
  await act(() => startButton(screen.container).click());
  expect(start).toHaveBeenCalledTimes(2);
  expect(
    goalProposalBannerItem({ ...props, canStart: false, canDismiss: false }).onDismiss,
  ).toBeUndefined();
});
