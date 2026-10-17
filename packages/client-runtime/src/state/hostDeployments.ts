import {
  type EnvironmentId,
  type HostDeployment,
  type HostDeploymentMilestones,
  type HostDeploymentAdmissionMode,
  type HostDeploymentRequest,
  type HostDeploymentTarget,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentRpcUnavailableError, subscribe } from "../rpc/client.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  followStreamInEnvironment,
} from "./runtime.ts";
import {
  type MachineUpdateResult,
  runUpdateAll,
  type UpdateAllState,
} from "./updateAllMachines.ts";

/** What a client waits for on a host: a final outcome, or the local host's admission point. */
export type HostDeploymentWait = "settled" | "admission";

const STOPPED = new Set(["blocked", "failed", "cancelled"]);
const SETTLED = new Set(["verified", "accepted", "blocked", "failed", "cancelled"]);

export function hostDeploymentReached(record: HostDeployment, until: HostDeploymentWait): boolean {
  if (until === "settled") return SETTLED.has(record.status);
  return (
    STOPPED.has(record.status) ||
    record.admission !== null ||
    (record.status === "waiting" && record.step === "admission")
  );
}

/** A remote counts as updated once its install is verified on the approved release. */
export function remoteDeploymentResult(record: HostDeployment): MachineUpdateResult {
  return record.status === "verified" || record.status === "accepted"
    ? { status: "succeeded", targetVersion: record.request.version }
    : {
        status: "failed",
        message: record.reason ?? `${record.request.version} is ${record.status} on this host.`,
      };
}

/** A release is done only when every target verified and recorded its acceptance receipt. */
export function releaseDeploymentDone(
  request: HostDeploymentRequest,
  records: ReadonlyMap<string, HostDeployment>,
): boolean {
  return request.targets.every(
    (target) => records.get(target.environmentId)?.status === "accepted",
  );
}

/** The release this host is working on or finished last: latest approval wins. */
export function latestHostDeployment(
  deployments: ReadonlyArray<HostDeployment>,
): HostDeployment | null {
  let latest: HostDeployment | null = null;
  for (const record of deployments) {
    if (
      latest === null ||
      Date.parse(record.request.approvedAt) > Date.parse(latest.request.approvedAt) ||
      (record.request.approvedAt === latest.request.approvedAt &&
        Date.parse(record.updatedAt) > Date.parse(latest.updatedAt))
    ) {
      latest = record;
    }
  }
  return latest;
}

export function hostDeploymentStatusLabel(record: HostDeployment): string {
  switch (record.status) {
    case "preparing":
      return record.step === "download" ? "Downloading" : "Preparing";
    case "waiting":
      return record.step === "admission" ? "Waiting for remotes" : "Waiting for idle";
    case "installing":
      return "Installing";
    case "verified":
      return "Verified";
    case "accepted":
      return "Accepted";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

const MILESTONES: ReadonlyArray<readonly [keyof HostDeploymentMilestones, string]> = [
  ["approvedAt", "Approved"],
  ["publishedAt", "Published"],
  ["installedAt", "Installed"],
  ["verifiedAt", "Verified"],
  ["acceptedAt", "Accepted"],
];

export interface HostDeploymentMilestoneView {
  readonly label: string;
  readonly reached: boolean;
}

/** Approval, publish, install, verify and accept, in order, each marked reached or not. */
export function hostDeploymentMilestones(
  record: HostDeployment,
): ReadonlyArray<HostDeploymentMilestoneView> {
  return MILESTONES.map(([key, label]) => ({ label, reached: record.milestones[key] !== null }));
}

/**
 * Sequences an approved release with the remote-first `runUpdateAll`: every
 * host prepares at once, remotes install as soon as they are idle, and the
 * local host is admitted only after every remote verified. Each call is
 * idempotent, so running it again resumes a release after a restart.
 */
export async function runReleaseDeployment(input: {
  readonly request: HostDeploymentRequest;
  readonly submit: (
    environmentId: EnvironmentId,
    request: HostDeploymentRequest,
  ) => Promise<HostDeployment>;
  readonly awaitDeployment: (
    environmentId: EnvironmentId,
    until: HostDeploymentWait,
  ) => Promise<HostDeployment>;
  readonly admit: (
    environmentId: EnvironmentId,
    mode: HostDeploymentAdmissionMode,
    evidence: string,
  ) => Promise<HostDeployment>;
  readonly onState: (state: UpdateAllState) => void;
}): Promise<void> {
  const remotes = input.request.targets.filter((target) => target.role === "remote");
  const local = input.request.targets.find((target) => target.role === "local");
  await runUpdateAll<HostDeploymentTarget>({
    targets: remotes,
    updateRemote: async (target) => {
      await input.submit(target.environmentId, input.request);
      return remoteDeploymentResult(await input.awaitDeployment(target.environmentId, "settled"));
    },
    ...(local === undefined
      ? {}
      : {
          prepareLocal: async () => {
            await input.submit(local.environmentId, input.request);
            const record = await input.awaitDeployment(local.environmentId, "admission");
            if (STOPPED.has(record.status)) {
              throw new Error(record.reason ?? `This host's deployment is ${record.status}.`);
            }
          },
        }),
    installLocal: async () => {
      if (local === undefined) return;
      await input.admit(
        local.environmentId,
        "remotes-verified",
        remotes.length === 0
          ? "No remote hosts in this release."
          : `Verified on ${remotes.map((target) => target.label).join(", ")}.`,
      );
    },
    onState: input.onState,
  });
}

export function createHostDeploymentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const findRelease =
    (releaseId: string) => (list: { readonly deployments: ReadonlyArray<HostDeployment> }) =>
      list.deployments.find((record) => record.request.releaseId === releaseId);
  return {
    deploymentsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:deployments:live",
      tag: WS_METHODS.deploymentsSubscribe,
    }),
    requestDeployment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:deployments:request",
      tag: WS_METHODS.deploymentsRequest,
    }),
    admitDeployment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:deployments:admit",
      tag: WS_METHODS.deploymentsAdmit,
    }),
    retryDeployment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:deployments:retry",
      tag: WS_METHODS.deploymentsRetry,
    }),
    cancelDeployment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:deployments:cancel",
      tag: WS_METHODS.deploymentsCancel,
    }),
    recordDeploymentAcceptance: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:deployments:accept",
      tag: WS_METHODS.deploymentsRecordAcceptance,
    }),
    /**
     * Resolves when this host's record for `releaseId` reaches `until`. It
     * follows the host's own change stream, so an offline host keeps it
     * pending until it reconnects.
     */
    awaitDeployment: createEnvironmentCommand(runtime, {
      label: "environment-data:server:deployments:await",
      execute: (
        input: { readonly releaseId: string; readonly until: HostDeploymentWait },
        _registry,
        environmentId,
      ) =>
        // Followed across reconnects: the host restarts while installing.
        followStreamInEnvironment(
          environmentId,
          subscribe(WS_METHODS.deploymentsSubscribe, {}),
        ).pipe(
          Stream.map(findRelease(input.releaseId)),
          Stream.filter(
            (record): record is HostDeployment =>
              record !== undefined && hostDeploymentReached(record, input.until),
          ),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new EnvironmentRpcUnavailableError({
                    environmentId,
                    message: "The host stopped reporting its deployment.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
    }),
  };
}
