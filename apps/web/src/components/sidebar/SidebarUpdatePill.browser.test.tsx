import { EnvironmentId, type DesktopUpdateState } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SidebarMachineUpdateDetails, SidebarUpdatePill } from "./SidebarUpdatePill";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    hasUpdates: false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/desktopUpdate")>()),
  useDesktopUpdateState: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.update,
  ),
}));
// The pill only renders in the desktop app.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
// The fork's machine updates and approved releases stay idle here.
vi.mock("../../hooks/useUpdateAllMachines", () => ({
  useUpdateAllMachines: () => ({
    targets: [],
    run: null,
    pending: false,
    hasLocalUpdate: false,
    label: null,
    start: async () => {},
  }),
}));
vi.mock("../../hooks/useReleaseDeployment", () => ({
  useReleaseDeployment: () => ({
    eligible: false,
    preparing: false,
    running: false,
    request: null,
    summary: null,
    approval: null,
    acceptance: null,
  }),
}));
vi.mock("./useUpdateEverything", () => ({
  useUpdateEverything: () => ({
    hasUpdates: mocks.hasUpdates,
    summary: "Update everything",
    lines: [],
    restarts: [],
    skipped: [],
  }),
}));

function nightlyUpdate(releaseNotes: DesktopUpdateState["releaseNotes"]): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "nightly",
    currentVersion: "0.0.50-nightly.1",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.50-nightly.2",
    downloadedVersion: null,
    releaseNotes,
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

const RELEASE_NOTES: DesktopUpdateState["releaseNotes"] = [
  { version: "0.0.50-nightly.2", items: ["Faster sidebar."], totalItems: 1 },
];

function setup(update: DesktopUpdateState | null, { hasUpdates = false } = {}) {
  mocks.update = update;
  mocks.hasUpdates = hasUpdates;
}

function publish(update: DesktopUpdateState | null) {
  return act(() => {
    mocks.update = update;
    mocks.notify();
  });
}

const releaseNotes = () => document.querySelector('[aria-label="Nightly update release notes"]');

describe("SidebarUpdatePill release notes", () => {
  it("closes when the release notes stop applying", async () => {
    setup(nightlyUpdate(RELEASE_NOTES));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());

    await publish(nightlyUpdate([]));
    await vi.waitFor(() => expect(releaseNotes()).toBeNull());
  });

  it("opens when release notes arrive while the trigger has keyboard focus", async () => {
    setup(nightlyUpdate([]));
    await using _screen = await render(<SidebarUpdatePill />);
    await userEvent.tab();
    expect(releaseNotes()).toBeNull();

    await publish(nightlyUpdate(RELEASE_NOTES));
    await vi.waitFor(() => expect(releaseNotes()).not.toBeNull());
  });
});

describe("SidebarUpdatePill update everything", () => {
  it("does not refocus the update button after a pointer cancel", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    const cancel = page.getByRole("button", { name: "Cancel" });
    await expect.element(cancel).toBeVisible();

    await userEvent.click(cancel);
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(document.activeElement).not.toBe(button.element());
  });

  it("returns focus to the update button after Escape", async () => {
    setup(null, { hasUpdates: true });
    await using screen = await render(<SidebarUpdatePill />);
    const button = screen.getByRole("button", { name: "Update everything" });
    await userEvent.click(button);
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(button.element()));
  });
});

describe("SidebarMachineUpdateDetails", () => {
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
  const state = nightlyUpdate(RELEASE_NOTES);

  it("shows which machine failed and retries it or installs on this machine only", async () => {
    const start = vi.fn(async () => {});
    await using screen = await render(
      <SidebarMachineUpdateDetails
        machines={{ ...machines, start }}
        state={state}
        tooltip="Machine update failed"
      />,
    );
    await expect.element(screen.getByRole("alert").first()).toHaveTextContent("Remote timed out");
    await userEvent.click(screen.getByRole("button", { name: "Retry nick-mini" }));
    expect(start).toHaveBeenLastCalledWith("mini");
    await userEvent.click(screen.getByRole("button", { name: "Install on this machine only" }));
    expect(start).toHaveBeenLastCalledWith(undefined, true);
  });

  it("keeps recovery disabled while a machine is still running", async () => {
    await using screen = await render(
      <SidebarMachineUpdateDetails
        machines={{ ...machines, pending: true }}
        state={state}
        tooltip="Updating machines…"
      />,
    );
    await expect.element(screen.getByRole("button", { name: "Retry nick-mini" })).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Install on this machine only" }))
      .toBeDisabled();
  });

  it("offers no local install without a local update", async () => {
    await using screen = await render(
      <SidebarMachineUpdateDetails
        machines={{ ...machines, hasLocalUpdate: false }}
        state={state}
        tooltip="Machine update failed"
      />,
    );
    await expect.element(screen.getByRole("button", { name: "Retry nick-mini" })).toBeVisible();
    expect(document.body.textContent).not.toContain("This machine:");
    expect(document.body.textContent).not.toContain("Install on this machine only");
  });

  it("lists the version the remote's feed actually installed", async () => {
    await using _screen = await render(
      <SidebarMachineUpdateDetails
        machines={{
          ...machines,
          run: {
            local: "none",
            remotes: { mini: { status: "succeeded", targetVersion: "0.0.45-nick.12" } },
          },
        }}
        state={state}
        tooltip="Updated"
      />,
    );
    expect(document.body.textContent).toContain("0.0.45-nick.12");
    expect(document.body.textContent).not.toContain("Retry nick-mini");
  });
});
