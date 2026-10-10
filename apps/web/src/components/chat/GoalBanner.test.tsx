import { CommandId, type OrchestrationV2GoalProposal } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { goalProposalBannerItem } from "./GoalBanner";

vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (x: unknown) => x,
}));
const proposal = {
  id: CommandId.make("proposal"),
  objective: "Ship",
  doneWhen: "Tests pass",
  checkCommand: null,
  reason: null,
} as OrchestrationV2GoalProposal;
let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

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
  await act(async () => {
    renderer = create(<>{banner.actions}</>);
  });
  expect(start).not.toHaveBeenCalled();
  const click = renderer.root.findAllByType("button")[0]!.props.onClick;
  await act(async () => {
    click();
    click();
  });
  expect(start).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
  });
  await act(async () => {
    click();
  });
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
  await act(async () => {
    renderer = create(<>{goalProposalBannerItem(props).actions}</>);
  });
  await act(async () => {
    renderer.root.findAllByType("button")[0]!.props.onClick();
  });
  expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["Rejected"]);
  await act(async () => {
    renderer.root.findAllByType("button")[0]!.props.onClick();
  });
  expect(start).toHaveBeenCalledTimes(2);
  await act(async () => {
    renderer.update(
      <>{goalProposalBannerItem({ ...props, canStart: false, canDismiss: false }).actions}</>,
    );
  });
  await act(async () => {
    renderer.root.findAllByType("button")[0]!.props.onClick();
  });
  expect(start).toHaveBeenCalledTimes(2);
  expect(
    goalProposalBannerItem({ ...props, canStart: false, canDismiss: false }).onDismiss,
  ).toBeUndefined();
});
