import { describe, expect, it, vi } from "vite-plus/test";
import {
  canInstallLocal,
  runUpdateAll,
  updateAllConfirmation,
  updateAllLabel,
  type MachineUpdateResult,
  type UpdateAllState,
} from "./updateAllMachines.ts";

const success = { status: "succeeded", targetVersion: "0.0.45-nick.12" } as const;
const targets = [{ environmentId: "mini" }, { environmentId: "office" }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("update every machine", () => {
  it("starts remotes together with local download and installs only after all reconnect", async () => {
    const remote = targets.map(() => deferred<MachineUpdateResult>());
    const download = deferred<void>();
    const installLocal = vi.fn(async () => {});
    const states: UpdateAllState[] = [];
    const updateRemote = vi.fn(
      (target: (typeof targets)[number]) => remote[targets.indexOf(target)]!.promise,
    );
    const prepareLocal = vi.fn(() => download.promise);
    const beforeInstall = vi.fn();
    const run = runUpdateAll({
      targets,
      updateRemote,
      prepareLocal,
      installLocal,
      beforeInstall,
      onState: (state) => states.push(state),
    });
    await Promise.resolve();
    expect(updateRemote).toHaveBeenCalledTimes(2);
    expect(prepareLocal).toHaveBeenCalledOnce();
    download.resolve();
    remote[0]!.resolve(success);
    await Promise.resolve();
    expect(installLocal).not.toHaveBeenCalled();
    remote[1]!.resolve(success);
    await run;
    expect(installLocal).toHaveBeenCalledOnce();
    expect(beforeInstall.mock.invocationCallOrder[0]).toBeLessThan(
      installLocal.mock.invocationCallOrder[0]!,
    );
    expect(states.at(-1)?.local).toBe("installing");
  });

  it.each(["download failed", "remote update timed out"])(
    "blocks local restart on %s and supports retry",
    async (message) => {
      const installLocal = vi.fn(async () => {});
      let state!: UpdateAllState;
      const onState = (next: UpdateAllState) => {
        state = next;
      };
      await runUpdateAll({
        targets,
        updateRemote: async (target) =>
          target.environmentId === "mini" ? { status: "failed", message } : success,
        prepareLocal: async () => {},
        installLocal,
        onState,
      });
      expect(installLocal).not.toHaveBeenCalled();
      expect(state.remotes.mini).toEqual({ status: "failed", message });
      expect(canInstallLocal(state)).toBe(false);
      const retry = vi.fn(async () => success);
      await runUpdateAll({
        targets: [targets[0]!],
        previous: state,
        updateRemote: retry,
        prepareLocal: async () => {},
        installLocal,
        onState,
      });
      expect(retry).toHaveBeenCalledOnce();
      expect(state.remotes.office).toEqual(success);
      expect(installLocal).toHaveBeenCalledOnce();
    },
  );

  it("allows explicit local-only recovery after all remote attempts terminate", async () => {
    const installLocal = vi.fn(async () => {});
    const previous: UpdateAllState = {
      local: "ready",
      remotes: { mini: { status: "failed", message: "feed down" } },
    };
    await runUpdateAll({
      targets: [],
      previous,
      updateRemote: async () => success,
      prepareLocal: async () => {},
      installLocal,
      localOnly: true,
      onState: () => {},
    });
    expect(installLocal).toHaveBeenCalledOnce();
    expect(canInstallLocal({ ...previous, remotes: { mini: { status: "updating" } } }, true)).toBe(
      false,
    );
  });

  it("joins every attempt even when local download throws synchronously", async () => {
    const remote = deferred<MachineUpdateResult>();
    let finished = false;
    const installLocal = vi.fn(async () => {});
    const run = runUpdateAll({
      targets: [targets[0]!],
      updateRemote: () => remote.promise,
      prepareLocal: () => {
        throw new Error("local failed");
      },
      installLocal,
      onState: () => {},
    }).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    remote.resolve(success);
    await run;
    expect(installLocal).not.toHaveBeenCalled();
  });

  it("treats a tokenless up-to-date result as success", async () => {
    const installLocal = vi.fn(async () => {});
    await runUpdateAll({
      targets: [targets[0]!],
      updateRemote: async () => ({ status: "succeeded", targetVersion: "0.0.45-nick.10" }),
      prepareLocal: async () => {},
      installLocal,
      onState: () => {},
    });
    expect(installLocal).toHaveBeenCalledOnce();
  });

  it("supports remote-only and local-only updates", async () => {
    const installLocal = vi.fn(async () => {});
    await runUpdateAll({
      targets,
      updateRemote: async () => success,
      installLocal,
      onState: () => {},
    });
    expect(installLocal).not.toHaveBeenCalled();
    await runUpdateAll({
      targets: [],
      updateRemote: async () => success,
      prepareLocal: async () => {},
      installLocal,
      onState: () => {},
    });
    expect(installLocal).toHaveBeenCalledOnce();
  });

  it("performs no state publications after invoking local install", async () => {
    let installing = false;
    await runUpdateAll({
      targets,
      updateRemote: async () => success,
      prepareLocal: async () => {},
      installLocal: async () => {
        installing = true;
      },
      onState: () => expect(installing).toBe(false),
    });
  });

  it("names every machine, versions, running threads, and continuation in one confirmation", () => {
    const message = updateAllConfirmation([
      {
        serverLabel: "nick-mini",
        fromVersion: "nick.10",
        targetVersion: "nick.12",
        runningThreadCount: 2,
        threadContinuation: true,
        continueThreadsAfterServerUpdate: true,
      },
      {
        serverLabel: "This machine",
        fromVersion: "nick.10",
        targetVersion: "nick.12",
        runningThreadCount: 1,
      },
    ]);
    expect(message).toContain(
      "nick-mini: nick.10 → nick.12; 2 running threads. Running threads continue",
    );
    expect(message).toContain(
      "This machine: nick.10 → nick.12; 1 running thread. Running threads stop",
    );
    expect(message).toContain("all remotes reconnect successfully");
  });

  it("labels local-only, remote-only, and multi-machine pills", () => {
    expect(updateAllLabel([], true)).toBeNull();
    expect(updateAllLabel(["nick-mini"], false)).toBe("Update nick-mini");
    expect(updateAllLabel(["nick-mini"], true)).toBe("Update all (2)");
    expect(updateAllLabel(["mini", "office"], false)).toBe("Update all (2)");
  });
});
