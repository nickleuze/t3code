import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";
import { prepareLocalDesktopUpdate } from "./localDesktopUpdate";

const state: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.45-nick.10",
  availableVersion: "0.0.45-nick.11",
  downloadedVersion: null,
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
function bridge(initial = state) {
  let observe!: (state: DesktopUpdateState) => void;
  const unsubscribe = vi.fn();
  return {
    getUpdateState: vi.fn(async () => initial),
    onUpdateState: vi.fn((callback: (state: DesktopUpdateState) => void) => {
      observe = callback;
      return unsubscribe;
    }),
    downloadUpdate: vi.fn(async () => ({
      accepted: true,
      completed: true,
      state: { ...state, status: "downloading" as const },
    })),
    emit: (next: DesktopUpdateState) => observe(next),
    unsubscribe,
  };
}
afterEach(() => vi.useRealTimers());
describe("local preparation", () => {
  it("waits for the downloaded event after the RPC resolves", async () => {
    const mock = bridge();
    let ready = false;
    const result = prepareLocalDesktopUpdate(mock).then(() => {
      ready = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.downloadUpdate).toHaveBeenCalledOnce();
    expect(ready).toBe(false);
    mock.emit({ ...state, status: "downloaded", downloadedVersion: state.availableVersion });
    await result;
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
  });
  it("joins a background download without starting another", async () => {
    const mock = bridge({ ...state, status: "downloading" });
    const result = prepareLocalDesktopUpdate(mock);
    await Promise.resolve();
    expect(mock.downloadUpdate).not.toHaveBeenCalled();
    mock.emit({ ...state, status: "downloaded", downloadedVersion: state.availableVersion });
    await result;
  });
  it("accepts an already downloaded update", async () => {
    const mock = bridge({
      ...state,
      status: "downloaded",
      downloadedVersion: state.availableVersion,
    });
    await prepareLocalDesktopUpdate(mock);
    expect(mock.downloadUpdate).not.toHaveBeenCalled();
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
  });
  it("rejects a failed download and removes the listener", async () => {
    const mock = bridge();
    const result = prepareLocalDesktopUpdate(mock);
    const rejection = expect(result).rejects.toThrow("network down");
    await Promise.resolve();
    await Promise.resolve();
    mock.emit({ ...state, status: "error", errorContext: "download", message: "network down" });
    await rejection;
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
  });
  it("bounds a silent background download", async () => {
    vi.useFakeTimers();
    const mock = bridge({ ...state, status: "downloading" });
    const rejection = expect(prepareLocalDesktopUpdate(mock)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await rejection;
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
  });
});
