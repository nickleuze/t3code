import { describe, expect, it } from "vite-plus/test";
import type { AuthSessionState, DesktopUpdateState, ServerConfig } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import type { EnvironmentPresentation } from "./state/environments";
import { newestKnownUpdateVersion, savedServerUpdateTargets } from "./serverUpdateTargets";

const session: AuthSessionState = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
    serverUpdateScope: "environment:maintain",
  },
};
function row(overrides: Partial<EnvironmentPresentation> = {}) {
  const environment: EnvironmentPresentation = {
    environmentId: EnvironmentId.make("mini"),
    label: "nick-mini",
    displayUrl: null,
    relayManaged: false,
    entry: {
      target: new BearerConnectionTarget({
        environmentId: EnvironmentId.make("mini"),
        connectionId: "mini",
        label: "nick-mini",
      }),
      enabled: true,
      profile: Option.none(),
    },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: {
      environment: {
        serverVersion: "0.0.45-nick.10",
        capabilities: {
          serverSelfUpdate: "desktop-managed",
          desktopAppUpdate: true,
          serverUpdateThreadContinuation: true,
        },
      },
      settings: { continueThreadsAfterServerUpdate: true },
    } as unknown as ServerConfig,
    ...overrides,
  };
  return { environment, session, updateStatus: "idle", runningThreadCount: 3 };
}

describe("shared update targets", () => {
  it("finds a remote on the same old build before this Mac updates", () => {
    expect(savedServerUpdateTargets([row()], "0.0.45-nick.11", true)).toEqual([
      expect.objectContaining({
        serverLabel: "nick-mini",
        fromVersion: "0.0.45-nick.10",
        targetVersion: "0.0.45-nick.11",
        runningThreadCount: 3,
        continueThreadsAfterServerUpdate: true,
      }),
    ]);
    expect(savedServerUpdateTargets([row()], "0.0.45-nick.9", true)).toEqual([]);
    expect(savedServerUpdateTargets([row()], "0.0.45-nick.10", true)).toEqual([]);
  });
  it.each(["offline", "connecting", "reconnecting"] as const)("excludes %s remotes", (phase) => {
    expect(
      savedServerUpdateTargets(
        [row({ connection: { phase, error: null, traceId: null } })],
        "0.0.45-nick.12",
        true,
      ),
    ).toEqual([]);
  });
  it("excludes disabled, local, missing-scope, and already running targets", () => {
    const initial = row();
    const states = [
      row({ entry: { ...initial.environment.entry, enabled: false } }),
      row({
        entry: {
          ...initial.environment.entry,
          target: new BearerConnectionTarget({
            environmentId: EnvironmentId.make("mini"),
            connectionId: "local:wsl:test",
            label: "WSL",
          }),
        },
      }),
      row({
        entry: {
          ...initial.environment.entry,
          target: new PrimaryConnectionTarget({
            environmentId: EnvironmentId.make("local"),
            label: "Local",
            httpBaseUrl: "http://localhost:4000",
            wsBaseUrl: "ws://localhost:4000/ws",
          }),
        },
      }),
      { ...row(), session: { ...session, scopes: [] } },
      { ...row(), session: null },
      { ...row(), updateStatus: "running" },
    ];
    expect(savedServerUpdateTargets(states, "0.0.45-nick.12", true)).toEqual([]);
  });
  it.each([
    { serverSelfUpdate: undefined, desktopAppUpdate: true },
    { serverSelfUpdate: "desktop-managed", desktopAppUpdate: false },
    { serverSelfUpdate: "boot-service", desktopAppUpdate: false },
  ])("excludes unsupported desktop targets %j", (capabilities) => {
    const initial = row();
    const environment = {
      ...initial.environment,
      serverConfig: {
        ...initial.environment.serverConfig!,
        environment: { ...initial.environment.serverConfig!.environment, capabilities },
      } as unknown as ServerConfig,
    };
    expect(savedServerUpdateTargets([row(environment)], "0.0.45-nick.12", true)).toEqual([]);
  });
  it("keeps service updates available in Connections", () => {
    const initial = row();
    const config = initial.environment.serverConfig!;
    const environment = {
      ...initial.environment,
      serverConfig: {
        ...config,
        environment: {
          ...config.environment,
          capabilities: {
            ...config.environment.capabilities,
            serverSelfUpdate: "boot-service" as const,
          },
        },
      },
    };
    expect(savedServerUpdateTargets([row(environment)], "0.0.45-nick.12")).toHaveLength(1);
  });
  it("takes the numeric fork maximum of the app, available, and downloaded versions", () => {
    const state = {
      currentVersion: "0.0.45-nick.9",
      availableVersion: "0.0.45-nick.10",
      downloadedVersion: "0.0.45-nick.12",
    } as DesktopUpdateState;
    expect(newestKnownUpdateVersion(state, "0.0.45-nick.11")).toBe("0.0.45-nick.12");
    expect(
      newestKnownUpdateVersion(
        { ...state, availableVersion: "0.0.45-nick.8", downloadedVersion: null },
        "0.0.45-nick.11",
      ),
    ).toBe("0.0.45-nick.11");
    expect(newestKnownUpdateVersion(null, "0.0.45-nick.11")).toBe("0.0.45-nick.11");
  });
});
