import { describe, expect, it } from "vite-plus/test";
import { rejectedBeforeLaunch } from "./TicketLaunchService.ts";
describe("ticket prelaunch rejection", () => {
  it("only unlinks failures proven to precede creation", () => {
    expect(rejectedBeforeLaunch({ _tag: "EnvironmentAuthorizationError" })).toBe(true);
    expect(rejectedBeforeLaunch({ _tag: "AttachmentClaimError" })).toBe(true);
    expect(rejectedBeforeLaunch({ _tag: "ThreadLaunchError", operation: "resolve-project" })).toBe(
      true,
    );
    expect(
      rejectedBeforeLaunch({
        _tag: "OrchestrationV2ThreadLaunchError",
        cause: { _tag: "ThreadLaunchError", operation: "resolve-project" },
      }),
    ).toBe(true);
    expect(rejectedBeforeLaunch({ _tag: "ThreadLaunchError", operation: "create-thread" })).toBe(
      false,
    );
    expect(rejectedBeforeLaunch({ _tag: "ThreadLaunchError", operation: "dispatch-message" })).toBe(
      false,
    );
    expect(rejectedBeforeLaunch(new Error("response lost"))).toBe(false);
  });
});
