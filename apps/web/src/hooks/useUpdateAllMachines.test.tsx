import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "../confirmDialog";
import { useUpdateAllMachines } from "./useUpdateAllMachines";

const mock = vi.hoisted(() => ({
  updateRemote: vi.fn(),
  toast: vi.fn(),
  targets: [] as unknown[],
  otherUpdatePending: false,
  environments: [] as unknown[],
}));
vi.mock("./useServerUpdateTargets", () => ({ useServerUpdateTargets: () => mock.targets }));
vi.mock("../components/ServerUpdateAction", () => ({
  useServerUpdate: () => mock.updateRemote,
  hasPendingServerUpdates: () => mock.otherUpdatePending,
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mock.toast } }));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => null,
  useEnvironments: () => ({ environments: mock.environments }),
}));
vi.mock("../state/threads", () => ({ environmentThreadShells: {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => 2 }));

const local: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "nightly",
  currentVersion: "0.0.45-nick.10",
  availableVersion: "0.0.45-nick.11",
  downloadedVersion: "0.0.45-nick.11",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
const remote = {
  environmentId: EnvironmentId.make("mini"),
  serverLabel: "nick-mini",
  selfUpdate: "desktop-managed",
  desktopAppUpdate: true,
  fromVersion: "0.0.45-nick.10",
  targetVersion: "0.0.45-nick.11",
  runningThreadCount: 3,
  threadContinuation: true,
  continueThreadsAfterServerUpdate: true,
} as const;
let renderer: ReactTestRenderer | undefined;
let value!: ReturnType<typeof useUpdateAllMachines>;
const storage = new Map<string, string>();
let bridge: {
  getUpdateState: ReturnType<typeof vi.fn>;
  onUpdateState: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  installUpdate: ReturnType<typeof vi.fn>;
};
function Control({ state }: { state: DesktopUpdateState }) {
  value = useUpdateAllMachines(state);
  return <span>{value.label}</span>;
}
async function mount(state = local) {
  await act(async () => {
    renderer = create(<Control state={state} />);
  });
}
beforeEach(() => {
  mock.updateRemote.mockReset();
  mock.toast.mockReset();
  mock.otherUpdatePending = false;
  mock.environments = [];
  mock.targets = [remote];
  resetConfirmDialogForTests();
  registerConfirmDialogHost();
  storage.clear();
  bridge = {
    getUpdateState: vi.fn(async () => local),
    onUpdateState: vi.fn(() => () => {}),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(async () => ({ accepted: true, completed: false, state: local })),
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    desktopBridge: bridge,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  resetConfirmDialogForTests();
  vi.unstubAllGlobals();
});

describe("pill update-all controller", () => {
  it("asks once, preserves thread settings, and installs locally only after remote completion", async () => {
    let finish!: (value: { status: "succeeded"; targetVersion: string }) => void;
    mock.updateRemote.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    expect(value.label).toBe("Update all (2)");
    let run!: Promise<void>;
    await act(async () => {
      run = value.start();
      void value.start();
    });
    const confirmation = readConfirmDialogState();
    expect(confirmation.status).toBe("confirming");
    expect(confirmation).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "nick-mini: 0.0.45-nick.10 → 0.0.45-nick.11; 3 running threads",
        ),
      }),
    );
    expect(mock.updateRemote).not.toHaveBeenCalled();
    await act(async () => {
      respondToConfirmDialog(true);
      completeConfirmDialogClose();
    });
    expect(mock.updateRemote).toHaveBeenCalledWith(remote);
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    await act(async () => {
      finish({ status: "succeeded", targetVersion: "0.0.45-nick.12" });
      await run;
    });
    expect(bridge.installUpdate).toHaveBeenCalledOnce();
    expect(JSON.parse([...storage.values()][0]!)).toEqual(
      expect.objectContaining({
        remotes: [
          { environmentId: "mini", serverLabel: "nick-mini", targetVersion: "0.0.45-nick.12" },
        ],
      }),
    );
    expect(value.run?.local).toBe("installing");
  });
  it("cancels before any updater call", async () => {
    await mount();
    await act(async () => {
      const run = value.start();
      respondToConfirmDialog(false);
      completeConfirmDialogClose();
      await run;
    });
    expect(mock.updateRemote).not.toHaveBeenCalled();
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    expect(value.pending).toBe(false);
  });
  it("retains a named failure, then explicitly installs on this machine only", async () => {
    mock.updateRemote.mockResolvedValue({ status: "failed", message: "remote timed out" });
    await mount();
    await act(async () => {
      const run = value.start();
      respondToConfirmDialog(true);
      completeConfirmDialogClose();
      await run;
    });
    expect(value.run?.remotes.mini).toEqual({ status: "failed", message: "remote timed out" });
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    let recovery!: Promise<void>;
    await act(async () => {
      recovery = value.start(undefined, true);
    });
    expect(readConfirmDialogState()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("Remote failures will be skipped"),
      }),
    );
    await act(async () => {
      respondToConfirmDialog(true);
      completeConfirmDialogClose();
      await recovery;
    });
    expect(mock.updateRemote).toHaveBeenCalledOnce();
    expect(bridge.installUpdate).toHaveBeenCalledOnce();
  });
  it("does not bypass a different in-flight remote on local-only recovery", async () => {
    mock.updateRemote.mockResolvedValue({ status: "failed", message: "feed down" });
    await mount();
    await act(async () => {
      const run = value.start();
      respondToConfirmDialog(true);
      completeConfirmDialogClose();
      await run;
    });
    mock.otherUpdatePending = true;
    await act(async () => {
      const run = value.start(undefined, true);
      respondToConfirmDialog(true);
      completeConfirmDialogClose();
      await run;
    });
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    expect(value.run?.localError).toContain("still updating");
  });
  it("supports a remote-only pill while this machine is up to date", async () => {
    mock.updateRemote.mockResolvedValue({
      status: "succeeded",
      targetVersion: remote.targetVersion,
    });
    await mount({
      ...local,
      status: "up-to-date",
      availableVersion: null,
      downloadedVersion: null,
    });
    expect(value.label).toBe("Update nick-mini");
    await act(async () => {
      const run = value.start();
      respondToConfirmDialog(true);
      completeConfirmDialogClose();
      await run;
    });
    expect(mock.updateRemote).toHaveBeenCalledOnce();
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });
  it("reports actual reconnect versions after local relaunch, including an old-version failure", async () => {
    await mount();
    mock.updateRemote.mockResolvedValue({ status: "succeeded", targetVersion: "0.0.45-nick.12" });
    await act(async () => {
      const run = value.start();
      respondToConfirmDialog(true);
      completeConfirmDialogClose();
      await run;
    });
    await act(async () => renderer?.unmount());
    mock.environments = [
      {
        environmentId: "mini",
        connection: { phase: "connected" },
        serverConfig: { environment: { serverVersion: "0.0.45-nick.10" } },
      },
    ];
    await mount({
      ...local,
      currentVersion: "0.0.45-nick.11",
      status: "up-to-date",
      availableVersion: null,
      downloadedVersion: null,
    });
    expect(mock.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "nick-mini update failed",
        description: expect.stringContaining("expected 0.0.45-nick.12"),
      }),
    );
  });
});
