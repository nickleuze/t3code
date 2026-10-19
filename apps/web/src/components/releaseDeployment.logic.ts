import {
  type DesktopReleaseManifest,
  type EnvironmentId,
  type HostDeployment,
  HostDeploymentRequest,
  type HostDeploymentStatus,
  isHostDeploymentTerminal,
} from "@t3tools/contracts";
import {
  hostDeploymentMilestones,
  hostDeploymentStatusLabel,
  latestHostDeployment,
} from "@t3tools/client-runtime/state/hostDeployments";
import * as Schema from "effect/Schema";

import { compareUpdateVersions } from "../versionSkew";

const LOCAL_DEPLOYMENT_LABEL = "This machine";
/** A finished release stays visible in the update popover for a day. */
const RECENT_RELEASE_MS = 24 * 60 * 60 * 1000;
const STOPPED: ReadonlySet<HostDeploymentStatus> = new Set(["blocked", "failed", "cancelled"]);
const MOVING: ReadonlySet<HostDeploymentStatus> = new Set(["preparing", "waiting", "installing"]);

/**
 * The approved path replaces Update all only when every host it would touch
 * can run a release deployment. Otherwise the first release with this
 * feature installs the old way.
 */
export function releaseDeploymentEligible(input: {
  readonly hasManifestBridge: boolean;
  readonly localSupported: boolean;
  readonly canRequestLocally: boolean;
  readonly hasLocalUpdate: boolean;
  readonly remotesSupported: ReadonlyArray<boolean>;
}): boolean {
  return (
    input.hasManifestBridge &&
    input.localSupported &&
    input.canRequestLocally &&
    (input.hasLocalUpdate || input.remotesSupported.length > 0) &&
    input.remotesSupported.every(Boolean)
  );
}

export interface ReleaseApprovalTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly role: "remote" | "local";
}

/** Remotes first, then this machine when it has the update. */
export function orderReleaseTargets(
  remotes: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly serverLabel: string }>,
  localEnvironmentId: EnvironmentId | null,
): ReadonlyArray<ReleaseApprovalTarget> {
  return [
    ...remotes.map((remote) => ({
      environmentId: remote.environmentId,
      label: remote.serverLabel,
      role: "remote" as const,
    })),
    ...(localEnvironmentId === null
      ? []
      : [
          {
            environmentId: localEnvironmentId,
            label: LOCAL_DEPLOYMENT_LABEL,
            role: "local" as const,
          },
        ]),
  ];
}

export function releaseTargetSequence(targets: ReadonlyArray<{ readonly label: string }>): string {
  return targets.map((target) => target.label).join(" → ");
}

export function shortReleaseDigest(value: string): string {
  return value.slice(0, 12);
}

const decodeRequest = Schema.decodeUnknownSync(HostDeploymentRequest);

/** Pins the release and uses the host's built-in installation checks. */
export function buildReleaseDeploymentRequest(input: {
  readonly manifest: DesktopReleaseManifest;
  readonly targets: ReadonlyArray<ReleaseApprovalTarget>;
  readonly approvedAt: string;
}): HostDeploymentRequest {
  return decodeRequest({
    releaseId: input.manifest.version,
    version: input.manifest.version,
    commit: input.manifest.commit,
    artifactSha256: input.manifest.artifactSha256,
    artifactSha512: input.manifest.artifactSha512,
    ...(input.manifest.windowsArtifact === undefined
      ? {}
      : { windowsArtifact: input.manifest.windowsArtifact }),
    feed: input.manifest.feed,
    acceptanceScope: "The approved release starts with preserved data and readable settings.",
    automaticAcceptance: true,
    targets: input.targets.map((target) => ({
      environmentId: target.environmentId,
      label: target.label.trim(),
      role: target.role,
    })),
    approvedAt: input.approvedAt,
  });
}

export type DeploymentRecordsByEnvironment = ReadonlyMap<
  EnvironmentId,
  ReadonlyArray<HostDeployment>
>;

/** The newest release any host knows, while it is unfinished or finished recently. */
export function currentReleaseRequest(
  records: DeploymentRecordsByEnvironment,
  now: number,
): HostDeploymentRequest | null {
  const all = [...records.values()].flat();
  const latest = latestHostDeployment(all);
  if (latest === null) return null;
  const release = all.filter((record) => record.request.releaseId === latest.request.releaseId);
  const active = release.some(
    (record) =>
      !isHostDeploymentTerminal(record.status) ||
      now - Date.parse(record.updatedAt) < RECENT_RELEASE_MS,
  );
  return active ? latest.request : null;
}

/**
 * A newer published version replaces a release no host is still moving on.
 * Its stopped hosts can never pass the pinned-version check again, so the
 * update control offers the newer release instead of an endless retry.
 */
export function releaseSuperseded(
  request: HostDeploymentRequest,
  records: ReadonlyMap<string, HostDeployment>,
  newestVersion: string,
): boolean {
  return (
    compareUpdateVersions(newestVersion, request.version) > 0 &&
    ![...records.values()].some((record) => MOVING.has(record.status))
  );
}

/** Each target's own record for the release, keyed by environment id. */
export function releaseRecords(
  request: HostDeploymentRequest,
  records: DeploymentRecordsByEnvironment,
): ReadonlyMap<string, HostDeployment> {
  const result = new Map<string, HostDeployment>();
  for (const target of request.targets) {
    const record = records
      .get(target.environmentId)
      ?.find((entry) => entry.request.releaseId === request.releaseId);
    if (record !== undefined) result.set(target.environmentId, record);
  }
  return result;
}

export type DeploymentRowAction = "retry" | "cancel" | "accept";

export function deploymentRowActions(record: HostDeployment): ReadonlyArray<DeploymentRowAction> {
  if (STOPPED.has(record.status)) return ["retry"];
  if (record.status === "verified") return ["accept"];
  if (
    (record.status === "preparing" ||
      record.status === "waiting" ||
      record.status === "installing") &&
    record.step !== "commit"
  ) {
    return ["cancel"];
  }
  return [];
}

export interface DeploymentRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly role: "remote" | "local";
  readonly record: HostDeployment | null;
  readonly statusText: string;
  readonly reason: string | null;
  readonly offline: string | null;
  readonly milestones: ReadonlyArray<{ readonly label: string; readonly reached: boolean }>;
  readonly actions: ReadonlyArray<DeploymentRowAction>;
}

/**
 * One row per target in approval order. `runErrors` carries this client's
 * failures for hosts that never accepted the request (no record to read).
 */
export function deploymentRows(input: {
  readonly request: HostDeploymentRequest;
  readonly records: ReadonlyMap<string, HostDeployment>;
  readonly connectedIds: ReadonlySet<string>;
  readonly runErrors?: Readonly<Record<string, string>>;
}): ReadonlyArray<DeploymentRow> {
  return input.request.targets.map((target) => {
    const record = input.records.get(target.environmentId) ?? null;
    const connected = input.connectedIds.has(target.environmentId);
    return {
      environmentId: target.environmentId,
      label: target.label,
      role: target.role,
      record,
      statusText: record === null ? "Not started" : hostDeploymentStatusLabel(record),
      reason: record?.reason ?? input.runErrors?.[target.environmentId] ?? null,
      offline: connected ? null : `${target.label} is offline`,
      milestones: record === null ? [] : hostDeploymentMilestones(record),
      // A disconnected host cannot take a command; its row only reports.
      actions: record === null || !connected ? [] : deploymentRowActions(record),
    };
  });
}

export interface LocalOnlyOverride {
  readonly confirmation: string;
  readonly evidence: string;
}

/**
 * Installing on this machine without its remotes is offered only while the local
 * host waits for admission and some remote cannot verify: it stopped, or its
 * environment is not connected.
 */
export function localOnlyOverride(input: {
  readonly request: HostDeploymentRequest;
  readonly records: ReadonlyMap<string, HostDeployment>;
  readonly connectedIds: ReadonlySet<string>;
}): LocalOnlyOverride | null {
  const local = input.request.targets.find((target) => target.role === "local");
  if (local === undefined || !input.connectedIds.has(local.environmentId)) return null;
  const record = input.records.get(local.environmentId);
  if (
    record === undefined ||
    record.admission !== null ||
    record.status !== "waiting" ||
    record.step !== "admission"
  ) {
    return null;
  }
  const blockers = input.request.targets.flatMap((target) => {
    if (target.role !== "remote") return [];
    if (!input.connectedIds.has(target.environmentId)) return [`${target.label} is offline`];
    const remote = input.records.get(target.environmentId);
    if (remote === undefined || !STOPPED.has(remote.status)) return [];
    return [`${target.label} is ${remote.status}: ${remote.reason ?? "no reason reported"}`];
  });
  if (blockers.length === 0) return null;
  const reasons = blockers.join("; ");
  return {
    confirmation: `Install ${input.request.version} on this machine without its remotes?\n\n${reasons}.\n\nThis machine backs up its state, waits until it is idle, then installs and relaunches.`,
    evidence: `Installed on this machine without verified remotes: ${reasons}.`,
  };
}

/** Tooltip for the sidebar control while a release is visible. */
export function releaseDeploymentSummary(
  request: HostDeploymentRequest,
  rows: ReadonlyArray<DeploymentRow>,
  done: boolean,
): string {
  if (done) return `${request.version} deployed`;
  if (rows.some((row) => row.record !== null && STOPPED.has(row.record.status))) {
    return `${request.version} needs attention`;
  }
  if (rows.some((row) => row.record?.status === "verified")) {
    return `${request.version} needs acceptance`;
  }
  return `Deploying ${request.version}`;
}

/**
 * A local record still waiting for this client to sequence it, e.g. after
 * this app restarted mid-release. Re-running the sequence is idempotent.
 */
export function releaseToResume(
  localRecords: ReadonlyArray<HostDeployment>,
): HostDeploymentRequest | null {
  const record = localRecords.find(
    (entry) =>
      entry.role === "local" &&
      entry.admission === null &&
      !isHostDeploymentTerminal(entry.status) &&
      !STOPPED.has(entry.status),
  );
  return record?.request ?? null;
}

/** Connections settings: the latest release on one host, read-only. */
export function environmentDeploymentStatus(
  records: ReadonlyArray<HostDeployment>,
  serverVersion?: string,
): { readonly text: string; readonly reason: string | null; readonly stopped: boolean } | null {
  const latest = latestHostDeployment(records);
  if (latest === null) return null;
  // A stopped release the host has since moved past, e.g. by a manual install, is moot.
  if (
    STOPPED.has(latest.status) &&
    serverVersion !== undefined &&
    compareUpdateVersions(serverVersion, latest.request.version) >= 0
  ) {
    return null;
  }
  return {
    text: `${latest.request.version} · ${hostDeploymentStatusLabel(latest)}`,
    reason: latest.reason,
    stopped: STOPPED.has(latest.status),
  };
}
