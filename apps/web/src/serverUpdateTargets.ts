import type { AuthSessionState, DesktopUpdateState } from "@t3tools/contracts";
import { AuthEnvironmentMaintainScope, sessionGrantsScope } from "@t3tools/contracts";
import type { EnvironmentPresentation } from "./state/environments";
import type { ServerUpdateTarget } from "./components/ServerUpdateAction";
import { APP_VERSION } from "./branding";
import { isDesktopLocalConnectionTarget } from "./connection/desktopLocal";
import {
  compareUpdateVersions,
  resolveVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "./versionSkew";

export interface SavedServerUpdateTarget extends ServerUpdateTarget {
  readonly fromVersion: string;
  readonly runningThreadCount: number;
}

export function newestKnownUpdateVersion(
  state: DesktopUpdateState | null,
  appVersion = APP_VERSION,
): string {
  return [state?.currentVersion, state?.availableVersion, state?.downloadedVersion].reduce<string>(
    (newest, version) => (version && compareUpdateVersions(version, newest) > 0 ? version : newest),
    appVersion,
  );
}

/** Shared by Connections and the desktop pill; the remote feed owns its actual target. */
export function savedServerUpdateTargets(
  states: ReadonlyArray<{
    readonly environment: EnvironmentPresentation;
    readonly updateStatus: string;
    readonly session: AuthSessionState | null;
    readonly runningThreadCount: number;
  }>,
  targetVersion = APP_VERSION,
  desktopOnly = false,
): SavedServerUpdateTarget[] {
  return states.flatMap(({ environment, updateStatus, session, runningThreadCount }) => {
    const mismatch = resolveVersionMismatch(
      environment.serverConfig?.environment.serverVersion,
      targetVersion,
    );
    const selfUpdate = resolveServerSelfUpdateCapability(environment.serverConfig);
    const desktopAppUpdate = supportsDesktopAppUpdate(environment.serverConfig);
    if (
      !mismatch ||
      updateStatus === "running" ||
      !environment.entry.enabled ||
      environment.entry.target._tag === "PrimaryConnectionTarget" ||
      environment.connection.phase !== "connected" ||
      isDesktopLocalConnectionTarget(environment.entry.target) ||
      !session?.authenticated ||
      !sessionGrantsScope(session, AuthEnvironmentMaintainScope) ||
      selfUpdate === null ||
      (desktopOnly && selfUpdate !== "desktop-managed") ||
      (selfUpdate === "desktop-managed" && !desktopAppUpdate)
    )
      return [];
    return [
      {
        environmentId: environment.environmentId,
        serverLabel: environment.label,
        selfUpdate,
        installation: environment.serverConfig?.environment.capabilities.serverInstallation,
        desktopAppUpdate,
        threadContinuation: supportsServerUpdateThreadContinuation(environment.serverConfig),
        continueThreadsAfterServerUpdate:
          environment.serverConfig?.settings.continueThreadsAfterServerUpdate ?? false,
        targetVersion: mismatch.clientVersion,
        fromVersion: mismatch.serverVersion,
        runningThreadCount,
      },
    ];
  });
}
