import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Release deployment: one release, approved by the user, installed on a fixed
 * set of hosts. Each host's server owns its own `HostDeployment` record; the
 * client sequences hosts (remotes first) by reading those records.
 */

export const HostDeploymentRole = Schema.Literals(["remote", "local"]);
export type HostDeploymentRole = typeof HostDeploymentRole.Type;

export const HostDeploymentTarget = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  role: HostDeploymentRole,
});
export type HostDeploymentTarget = typeof HostDeploymentTarget.Type;

/** The GitHub repository the desktop updater's `app-update.yml` points at. */
export const HostDeploymentFeed = Schema.Struct({
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
});
export type HostDeploymentFeed = typeof HostDeploymentFeed.Type;

/** Immutable once approved; `releaseId` is the release version. */
export const HostDeploymentRequest = Schema.Struct({
  releaseId: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  /** Full source commit from the release manifest. */
  commit: TrimmedNonEmptyString,
  artifactSha256: TrimmedNonEmptyString,
  /** Feed digest of the same archive, which electron-updater verifies. */
  artifactSha512: TrimmedNonEmptyString,
  feed: HostDeploymentFeed,
  /** What the feature acceptance receipt on each host must confirm. */
  acceptanceScope: TrimmedNonEmptyString,
  /** Omitted on older requests, which keep their manual feature acceptance. */
  automaticAcceptance: Schema.optional(Schema.Boolean),
  /** Remotes first; at most one local target. */
  targets: Schema.NonEmptyArray(HostDeploymentTarget),
  approvedAt: IsoDateTime,
});
export type HostDeploymentRequest = typeof HostDeploymentRequest.Type;

export const HostDeploymentStatus = Schema.Literals([
  "preparing",
  "waiting",
  "installing",
  "verified",
  "accepted",
  "blocked",
  "failed",
  "cancelled",
]);
export type HostDeploymentStatus = typeof HostDeploymentStatus.Type;

export const HostDeploymentStep = Schema.Literals([
  "preflight",
  "download",
  "admission",
  "idle",
  "backup",
  "commit",
  "verify",
]);
export type HostDeploymentStep = typeof HostDeploymentStep.Type;

export const HostDeploymentIdentity = Schema.Struct({
  version: TrimmedNonEmptyString,
  commit: Schema.NullOr(TrimmedNonEmptyString),
  /** Code signing authority and team, e.g. `Developer ID Application: … (TEAMID)`. */
  signing: Schema.NullOr(TrimmedNonEmptyString),
});
export type HostDeploymentIdentity = typeof HostDeploymentIdentity.Type;

export const HostDeploymentBackup = Schema.Struct({
  path: TrimmedNonEmptyString,
  databaseBytes: Schema.Number,
  threadCount: Schema.Number,
  projectCount: Schema.Number,
  /** The copied app bundle and the version its Info.plist reports. */
  appBundle: Schema.NullOr(Schema.Struct({ path: TrimmedNonEmptyString, version: Schema.String })),
  verifiedAt: IsoDateTime,
});
export type HostDeploymentBackup = typeof HostDeploymentBackup.Type;

export const HostDeploymentAdmissionMode = Schema.Literals(["remotes-verified", "local-only"]);
export type HostDeploymentAdmissionMode = typeof HostDeploymentAdmissionMode.Type;

export const HostDeploymentAdmission = Schema.Struct({
  mode: HostDeploymentAdmissionMode,
  /** Which remotes were verified, or why the user chose to install locally anyway. */
  evidence: TrimmedNonEmptyString,
  at: IsoDateTime,
});
export type HostDeploymentAdmission = typeof HostDeploymentAdmission.Type;

export const HostDeploymentAcceptance = Schema.Struct({
  scope: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  evidence: Schema.NullOr(Schema.String),
  at: IsoDateTime,
});
export type HostDeploymentAcceptance = typeof HostDeploymentAcceptance.Type;

/** Distinct milestones: approval is source acceptance, then publish, install, verify, accept. */
export const HostDeploymentMilestones = Schema.Struct({
  approvedAt: IsoDateTime,
  publishedAt: Schema.NullOr(IsoDateTime),
  installedAt: Schema.NullOr(IsoDateTime),
  verifiedAt: Schema.NullOr(IsoDateTime),
  acceptedAt: Schema.NullOr(IsoDateTime),
});
export type HostDeploymentMilestones = typeof HostDeploymentMilestones.Type;

export const HostDeployment = Schema.Struct({
  request: HostDeploymentRequest,
  environmentId: EnvironmentId,
  role: HostDeploymentRole,
  status: HostDeploymentStatus,
  step: HostDeploymentStep,
  /** Why the deployment is waiting, blocked or failed, in words a user can act on. */
  reason: Schema.NullOr(Schema.String),
  from: Schema.NullOr(HostDeploymentIdentity),
  runtime: Schema.NullOr(HostDeploymentIdentity),
  milestones: HostDeploymentMilestones,
  admission: Schema.NullOr(HostDeploymentAdmission),
  backup: Schema.NullOr(HostDeploymentBackup),
  acceptance: Schema.NullOr(HostDeploymentAcceptance),
  updatedAt: IsoDateTime,
});
export type HostDeployment = typeof HostDeployment.Type;

export function isHostDeploymentTerminal(status: HostDeploymentStatus): boolean {
  return status === "accepted" || status === "failed" || status === "cancelled";
}

export const HostDeploymentRequestInput = Schema.Struct({ request: HostDeploymentRequest });
export type HostDeploymentRequestInput = typeof HostDeploymentRequestInput.Type;

export const HostDeploymentAdmitInput = Schema.Struct({
  releaseId: TrimmedNonEmptyString,
  mode: HostDeploymentAdmissionMode,
  evidence: TrimmedNonEmptyString,
});
export type HostDeploymentAdmitInput = typeof HostDeploymentAdmitInput.Type;

export const HostDeploymentReleaseInput = Schema.Struct({ releaseId: TrimmedNonEmptyString });
export type HostDeploymentReleaseInput = typeof HostDeploymentReleaseInput.Type;

export const HostDeploymentAcceptanceInput = Schema.Struct({
  releaseId: TrimmedNonEmptyString,
  scope: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  evidence: Schema.optional(Schema.String),
});
export type HostDeploymentAcceptanceInput = typeof HostDeploymentAcceptanceInput.Type;

export const HostDeploymentListResult = Schema.Struct({
  deployments: Schema.Array(HostDeployment),
});
export type HostDeploymentListResult = typeof HostDeploymentListResult.Type;

export const HostDeploymentMutationResult = Schema.Struct({ deployment: HostDeployment });
export type HostDeploymentMutationResult = typeof HostDeploymentMutationResult.Type;

export class HostDeploymentError extends Schema.TaggedError<HostDeploymentError>()(
  "HostDeploymentError",
  {
    message: Schema.String,
    releaseId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
