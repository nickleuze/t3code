import { EnvironmentId, type DesktopUpdateState } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleSidebarUpdateReleaseNotesPopoverOpenChange,
  openSidebarUpdateReleaseNotesPopoverOnForwardTab,
  shouldUseSidebarUpdateReleaseNotesPopover,
  SidebarMachineUpdateDetails,
} from "./SidebarUpdatePill";

const nightlyState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.36-nightly.3",
  downloadedVersion: null,
  releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Newest change"], totalItems: 1 }],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("sidebar update release notes popover", () => {
  it("uses the popover only for visible nightly release notes", () => {
    expect(shouldUseSidebarUpdateReleaseNotesPopover(true, nightlyState)).toBe(true);
    expect(shouldUseSidebarUpdateReleaseNotesPopover(false, nightlyState)).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        channel: "latest",
      }),
    ).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...nightlyState,
        releaseNotes: [],
      }),
    ).toBe(false);
  });

  it("cancels trigger presses without canceling other open reasons", () => {
    const cancelTriggerPress = vi.fn();
    const cancelHover = vi.fn();

    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-press",
      cancel: cancelTriggerPress,
    });
    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-hover",
      cancel: cancelHover,
    });

    expect(cancelTriggerPress).toHaveBeenCalledOnce();
    expect(cancelHover).not.toHaveBeenCalled();
  });

  it("promotes forward Tab without preventing native navigation", () => {
    const open = vi.fn();
    const preventDefault = vi.fn();
    const event = { key: "Tab", shiftKey: false, preventDefault };

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(event, { open }, "nightly-release-notes");

    expect(open).toHaveBeenCalledWith("nightly-release-notes");
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not promote backward Tab", () => {
    const open = vi.fn();

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(
      { key: "Tab", shiftKey: true },
      { open },
      "nightly-release-notes",
    );

    expect(open).not.toHaveBeenCalled();
  });
});

describe("sidebar machine update details", () => {
  const machines: ComponentProps<typeof SidebarMachineUpdateDetails>["machines"] = {
    targets: [
      {
        environmentId: EnvironmentId.make("mini"),
        serverLabel: "nick-mini",
        selfUpdate: "desktop-managed",
        desktopAppUpdate: true,
        fromVersion: "0.0.45-nick.10",
        targetVersion: "0.0.45-nick.11",
        runningThreadCount: 0,
      },
    ],
    run: { remotes: { mini: { status: "failed", message: "Remote timed out" } }, local: "ready" },
    pending: false,
    hasLocalUpdate: true,
    label: "Update all (2)",
    start: async () => {},
  };
  it("shows which machine failed, why, retry, and local-only recovery", () => {
    const markup = renderToStaticMarkup(
      <SidebarMachineUpdateDetails
        machines={machines}
        state={nightlyState}
        tooltip="Machine update failed"
      />,
    );
    expect(markup).toContain("nick-mini");
    expect(markup).toContain("Remote timed out");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Retry nick-mini");
    expect(markup).toContain("Install on this Mac only");
  });
  it("keeps recovery disabled while a machine is still running", () => {
    const markup = renderToStaticMarkup(
      <SidebarMachineUpdateDetails
        machines={{ ...machines, pending: true }}
        state={nightlyState}
        tooltip="Updating machines…"
      />,
    );
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
  it("does not offer a local install on a remote-only client state", () => {
    const markup = renderToStaticMarkup(
      <SidebarMachineUpdateDetails
        machines={{ ...machines, hasLocalUpdate: false }}
        state={nightlyState}
        tooltip="Machine update failed"
      />,
    );
    expect(markup).not.toContain("This Mac:");
    expect(markup).not.toContain("Install on this Mac only");
    expect(markup).toContain("Retry nick-mini");
  });
  it("lists the actual version selected by the remote's feed", () => {
    const markup = renderToStaticMarkup(
      <SidebarMachineUpdateDetails
        machines={{
          ...machines,
          run: {
            local: "none",
            remotes: { mini: { status: "succeeded", targetVersion: "0.0.45-nick.12" } },
          },
        }}
        state={nightlyState}
        tooltip="Updated"
      />,
    );
    expect(markup).toContain("0.0.45-nick.12");
    expect(markup).not.toContain("Retry nick-mini");
  });
});
