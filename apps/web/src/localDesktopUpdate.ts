import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { resolveDesktopUpdateButtonAction } from "./components/desktopUpdate.logic";

/** Join background downloads too; subscribing before reads/actions avoids losing
 * the downloaded event that can land after downloadUpdate resolves.
 */
export function prepareLocalDesktopUpdate(
  bridge: Pick<DesktopBridge, "getUpdateState" | "onUpdateState" | "downloadUpdate">,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error("This Mac's download timed out.")),
      30 * 60_000,
    );
    const observe = (state: DesktopUpdateState) => {
      if (resolveDesktopUpdateButtonAction(state) === "install") finish();
      else if (state.status === "error")
        finish(new Error(state.message ?? "This Mac's download failed."));
    };
    unsubscribe = bridge.onUpdateState(observe);
    void bridge
      .getUpdateState()
      .then(async (state) => {
        if (settled) return;
        if (resolveDesktopUpdateButtonAction(state) === "install") return finish();
        if (state.status === "downloading") return;
        if (resolveDesktopUpdateButtonAction(state) !== "download") {
          return finish(new Error(state.message ?? "No update is ready on this Mac."));
        }
        const result = await bridge.downloadUpdate();
        if (!result.accepted && result.state.status !== "downloading") {
          return finish(
            new Error(result.state.message ?? "This Mac could not start the download."),
          );
        }
        observe(result.state);
      })
      .catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error("Download failed.")),
      );
  });
}
