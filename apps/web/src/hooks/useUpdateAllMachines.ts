import { useAtomValue } from "@effect/atom-react";
import type { DesktopUpdateState } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { requestConfirmDialog } from "../confirmDialog";
import { hasPendingServerUpdates, useServerUpdate } from "../components/ServerUpdateAction";
import { resolveDesktopUpdateButtonAction } from "../components/desktopUpdate.logic";
import { toastManager } from "../components/ui/toast";
import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { prepareLocalDesktopUpdate } from "../localDesktopUpdate";
import { newestKnownUpdateVersion, type SavedServerUpdateTarget } from "../serverUpdateTargets";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import { environmentThreadShells } from "../state/threads";
import {
  runUpdateAll,
  updateAllConfirmation,
  updateAllLabel,
  type UpdateAllState,
} from "@t3tools/client-runtime/state/updateAllMachines";
import { useServerUpdateTargets } from "./useServerUpdateTargets";

const RECEIPT_KEY = "t3code:update-all-reconnect:v1";
const Receipt = Schema.Struct({
  localFromVersion: Schema.String,
  remotes: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      serverLabel: Schema.String,
      targetVersion: Schema.String,
    }),
  ),
});

export function useUpdateAllMachines(localState: DesktopUpdateState | null) {
  const targets = useServerUpdateTargets(newestKnownUpdateVersion(localState), true);
  const updateRemote = useServerUpdate();
  const primary = usePrimaryEnvironment();
  const { environments } = useEnvironments();
  const localThreadsAtom = useMemo(
    () =>
      Atom.make((get) =>
        primary === null
          ? 0
          : get(environmentThreadShells.environmentThreadsAtom(primary.environmentId)).filter(
              (thread) => ["preparing", "starting", "running"].includes(thread.status),
            ).length,
      ),
    [primary],
  );
  const runningThreadCount = useAtomValue(localThreadsAtom);
  const [run, setRun] = useState<UpdateAllState | null>(null);
  const [runTargets, setRunTargets] = useState<ReadonlyArray<SavedServerUpdateTarget>>([]);
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const hasLocalUpdate =
    localState !== null &&
    (resolveDesktopUpdateButtonAction(localState) !== "none" ||
      localState.status === "downloading");

  useEffect(() => {
    if (!localState) return;
    try {
      const receipt = getLocalStorageItem(RECEIPT_KEY, Receipt);
      if (!receipt || receipt.localFromVersion === localState.currentVersion) return;
      const remaining = receipt.remotes.filter((remote) => {
        const environment = environments.find(
          (entry) => entry.environmentId === remote.environmentId,
        );
        if (environment?.connection.phase !== "connected" || !environment.serverConfig) return true;
        const version = environment.serverConfig.environment.serverVersion;
        const succeeded = version === remote.targetVersion;
        toastManager.add({
          type: succeeded ? "success" : "error",
          title: `${remote.serverLabel} ${succeeded ? "reconnected" : "update failed"}`,
          description: succeeded
            ? `Running ${version}.`
            : `Reconnected on ${version}; expected ${remote.targetVersion}.`,
        });
        return false;
      });
      if (remaining.length !== receipt.remotes.length) {
        setLocalStorageItem(RECEIPT_KEY, { ...receipt, remotes: remaining }, Receipt);
      }
    } catch {
      // Storage is best-effort; reconnect verification itself happens before local install.
    }
  }, [environments, localState]);

  const start = async (retryId?: string, localOnly = false) => {
    const bridge = window.desktopBridge;
    if (!bridge || active.current) return;
    active.current = true;
    setPending(true);
    let installing = false;
    let finalState: UpdateAllState | undefined;
    try {
      const selected = localOnly
        ? []
        : run
          ? runTargets.filter(
              (target) =>
                run.remotes[target.environmentId]?.status === "failed" &&
                (retryId === undefined || target.environmentId === retryId),
            )
          : targets;
      const machines = [
        ...selected,
        ...(hasLocalUpdate && localState
          ? [
              {
                serverLabel: "This Mac",
                fromVersion: localState.currentVersion,
                targetVersion:
                  localState.downloadedVersion ??
                  localState.availableVersion ??
                  localState.currentVersion,
                runningThreadCount,
                // Local install has no thread-continuation RPC.
                threadContinuation: false,
              },
            ]
          : []),
      ];
      if (machines.length === 0) return;
      const confirmed =
        (await requestConfirmDialog(
          updateAllConfirmation(
            machines,
            localOnly ? "local-only" : hasLocalUpdate ? "remote-first" : "remote-only",
          ),
        )) ?? true;
      if (!confirmed) return;
      if (!run) setRunTargets(selected);
      await runUpdateAll({
        targets: selected,
        ...(run ? { previous: run } : {}),
        updateRemote,
        ...(hasLocalUpdate ? { prepareLocal: () => prepareLocalDesktopUpdate(bridge) } : {}),
        localOnly,
        onState: (next) => {
          finalState = next;
          setRun(next);
        },
        beforeInstall: (next) => {
          if (hasPendingServerUpdates()) {
            throw new Error(
              "Another machine is still updating. Wait for it before installing on this Mac.",
            );
          }
          installing = true;
          if (!localState) return;
          try {
            setLocalStorageItem(
              RECEIPT_KEY,
              {
                localFromVersion: localState.currentVersion,
                remotes: (runTargets.length > 0 ? runTargets : selected).flatMap((target) => {
                  const result = next.remotes[target.environmentId];
                  return result?.status === "succeeded"
                    ? [
                        {
                          environmentId: target.environmentId,
                          serverLabel: target.serverLabel,
                          targetVersion: result.targetVersion,
                        },
                      ]
                    : [];
                }),
              },
              Receipt,
            );
          } catch {
            /* A storage failure must not prevent an already verified install. */
          }
        },
        installLocal: async () => {
          const result = await bridge.installUpdate();
          if (!result.accepted || result.state.status === "error") {
            throw new Error(result.state.message ?? "This Mac could not install the update.");
          }
        },
      });
      if (
        !installing &&
        finalState?.local === "none" &&
        Object.values(finalState.remotes).every((remote) => remote.status === "succeeded")
      ) {
        setRun(null);
        setRunTargets([]);
      }
    } catch (error) {
      installing = false;
      const message = error instanceof Error ? error.message : "Update failed.";
      setRun((previous) =>
        previous ? { ...previous, local: "failed", localError: message } : previous,
      );
      toastManager.add({ type: "error", title: "Could not update this Mac", description: message });
    } finally {
      // Only failure/cancellation/remote-only completion can need this client again.
      if (!installing) {
        active.current = false;
        setPending(false);
      }
    }
  };

  return {
    targets: run ? runTargets : targets,
    run,
    pending,
    hasLocalUpdate,
    label: updateAllLabel(
      (run ? runTargets : targets).map((target) => target.serverLabel),
      hasLocalUpdate,
    ),
    start,
  };
}
