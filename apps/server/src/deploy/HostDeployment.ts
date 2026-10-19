import {
  HostDeployment as HostDeploymentRecord,
  HostDeploymentError,
  type HostDeploymentAcceptanceInput,
  type HostDeploymentAdmitInput,
  type HostDeploymentIdentity,
  type HostDeploymentListResult,
  type HostDeploymentRequest,
  type HostDeploymentStatus,
  type HostDeploymentStep,
  isHostDeploymentTerminal,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { RunAdmissionGate } from "../orchestration-v2/RunAdmissionGate.ts";
import { HostDeploymentBlocked, HostDeploymentHost } from "./HostDeploymentHost.ts";

/** Verified backups kept on disk; older ones move to the Trash. */
const BACKUPS_KEPT = 2;
const BACKUP_TIMEOUT = Duration.minutes(30);
const ACTIVE_STATUSES: ReadonlySet<HostDeploymentStatus> = new Set([
  "preparing",
  "waiting",
  "installing",
]);
const BLOCKING_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(HostDeploymentRecord));
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(HostDeploymentRecord));

/** True when the effect ended only because it was interrupted. */
function isInterruption(exit: Exit.Exit<unknown, unknown>): boolean {
  return Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
}

/** A short build commit matches the release's full commit by prefix. */
function commitMatches(runtime: string | null, release: string): boolean {
  return (
    runtime !== null &&
    runtime.length >= 7 &&
    release.toLowerCase().startsWith(runtime.toLowerCase())
  );
}

function describeIdentity(identity: HostDeploymentIdentity): string {
  return identity.commit === null ? identity.version : `${identity.version} (${identity.commit})`;
}

function sameIdentity(left: HostDeploymentRequest, right: HostDeploymentRequest): boolean {
  return (
    left.version === right.version &&
    left.commit === right.commit &&
    left.artifactSha256 === right.artifactSha256 &&
    left.artifactSha512 === right.artifactSha512 &&
    left.windowsArtifact?.sha256 === right.windowsArtifact?.sha256 &&
    left.windowsArtifact?.sha512 === right.windowsArtifact?.sha512 &&
    left.feed.owner === right.feed.owner &&
    left.feed.repo === right.feed.repo
  );
}

export interface HostDeploymentShape {
  readonly request: (
    request: HostDeploymentRequest,
  ) => Effect.Effect<HostDeploymentRecord, HostDeploymentError>;
  readonly admit: (
    input: HostDeploymentAdmitInput,
  ) => Effect.Effect<HostDeploymentRecord, HostDeploymentError>;
  readonly retry: (releaseId: string) => Effect.Effect<HostDeploymentRecord, HostDeploymentError>;
  readonly cancel: (releaseId: string) => Effect.Effect<HostDeploymentRecord, HostDeploymentError>;
  readonly recordAcceptance: (
    input: HostDeploymentAcceptanceInput,
  ) => Effect.Effect<HostDeploymentRecord, HostDeploymentError>;
  readonly list: Effect.Effect<ReadonlyArray<HostDeploymentRecord>>;
  readonly subscribe: Stream.Stream<HostDeploymentListResult>;
}

/**
 * This host's part of an approved release deployment. The record is the
 * durable state: every step persists before it acts, startup reconciles an
 * install that restarted the app, and nothing ever re-commits on its own.
 */
export class HostDeployment extends Context.Service<HostDeployment, HostDeploymentShape>()(
  "t3/deploy/HostDeployment",
) {}

export const bootstrapSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS fork_schema_versions (
        component TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL
      )`;
      const versions = yield* sql<{ version: number }>`
        SELECT version FROM fork_schema_versions WHERE component = 'host-deployments'
      `;
      if (versions[0] !== undefined && versions[0].version !== 1) {
        return yield* Effect.die(new Error("Unsupported fork host deployments schema version."));
      }
      yield* sql`CREATE TABLE IF NOT EXISTS fork_host_deployments (
        release_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`;
      yield* sql`INSERT INTO fork_schema_versions (component, version)
        VALUES ('host-deployments', 1) ON CONFLICT (component) DO UPDATE SET version = 1`;
    }),
  );
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gate = yield* RunAdmissionGate;
  const eventSink = yield* EventSinkV2;
  const orchestrator = yield* OrchestratorV2;
  const projections = yield* ProjectionStoreV2;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const host = yield* HostDeploymentHost;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  yield* bootstrapSchema;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const error = (message: string, releaseId?: string, cause?: unknown) =>
    new HostDeploymentError({
      message,
      ...(releaseId === undefined ? {} : { releaseId }),
      ...(cause === undefined ? {} : { cause }),
    });

  const readAll = sql<{ readonly record_json: string }>`
    SELECT record_json FROM fork_host_deployments ORDER BY updated_at DESC LIMIT 50
  `.pipe(
    Effect.map((rows) => rows.map((row) => decodeRecord(row.record_json))),
    Effect.orDie,
  );

  const records = yield* SubscriptionRef.make<ReadonlyArray<HostDeploymentRecord>>(yield* readAll);
  // Serializes read-modify-write between drivers and user actions.
  const writes = yield* Semaphore.make(1);
  const drivers = yield* FiberMap.make<string>();

  const find = (releaseId: string) =>
    SubscriptionRef.get(records).pipe(
      Effect.map((all) => all.find((record) => record.request.releaseId === releaseId)),
    );

  const requireRecord = (releaseId: string) =>
    find(releaseId).pipe(
      Effect.flatMap((record) =>
        record === undefined
          ? Effect.fail(error(`No deployment of ${releaseId} on this host.`, releaseId))
          : Effect.succeed(record),
      ),
    );

  const persist = (record: HostDeploymentRecord) =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      const next = { ...record, updatedAt };
      yield* sql`
        INSERT INTO fork_host_deployments (release_id, status, record_json, updated_at)
        VALUES (${next.request.releaseId}, ${next.status}, ${encodeRecord(next)}, ${updatedAt})
        ON CONFLICT (release_id) DO UPDATE SET
          status = excluded.status,
          record_json = excluded.record_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.orDie);
      yield* SubscriptionRef.set(records, yield* readAll);
      return next;
    });

  /** Applies `change` to the current record under the write lock. */
  const update = (
    releaseId: string,
    change: (record: HostDeploymentRecord) => HostDeploymentRecord,
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* find(releaseId);
        if (current === undefined)
          return yield* Effect.die(new Error(`No deployment ${releaseId}.`));
        return yield* persist(change(current));
      }),
    );

  const setStep = (
    releaseId: string,
    status: HostDeploymentStatus,
    step: HostDeploymentStep,
    reason: string | null,
  ) => update(releaseId, (record) => ({ ...record, status, step, reason }));

  /** Downloads (or re-prepares) the update and checks it is the approved artifact. */
  const prepare = (record: HostDeploymentRecord) =>
    Effect.gen(function* () {
      const artifact = host.approvedArtifact(record.request);
      if (artifact === null) {
        return yield* new HostDeploymentBlocked({
          reason: `Release ${record.request.version} has no build for this host's platform.`,
        });
      }
      const prepared = yield* desktopAppUpdate
        .run(() => Effect.void, { deployment: record.request.releaseId })
        .pipe(
          Effect.mapError((cause) => new HostDeploymentBlocked({ reason: cause.reason, cause })),
        );
      const token = prepared.desktopUpdateToken;
      if (token === undefined) {
        return yield* new HostDeploymentBlocked({
          reason: "The desktop app did not return an install token.",
        });
      }
      // A refused artifact must not hold the desktop app's one preparation, or a retry is refused.
      const refuse = (reason: string) =>
        desktopAppUpdate
          .release(token)
          .pipe(Effect.andThen(Effect.fail(new HostDeploymentBlocked({ reason }))));
      if (prepared.targetVersion !== record.request.version) {
        return yield* refuse(
          `The update feed now offers ${prepared.targetVersion}; this deployment is pinned to ${record.request.version}.`,
        );
      }
      if (prepared.downloadedSha512 !== artifact.sha512) {
        return yield* refuse(
          prepared.downloadedSha512 === undefined
            ? "The desktop app did not report the downloaded artifact's digest, so it cannot be matched to the approved release."
            : "The downloaded artifact does not match the approved release's digest.",
        );
      }
      return token;
    });

  const blockingRunReason = (blocking: ReadonlyArray<{ readonly threadId: string }>) =>
    Effect.gen(function* () {
      const titles: Array<string> = [];
      for (const { threadId } of blocking.slice(0, 3)) {
        const shell = yield* projections
          .getThreadShell(ThreadId.make(threadId))
          .pipe(Effect.orElseSucceed(() => null));
        titles.push(shell === null ? threadId : `"${shell.title}"`);
      }
      const more =
        blocking.length > titles.length ? ` and ${blocking.length - titles.length} more` : "";
      return `Waiting for ${blocking.length} active run${blocking.length === 1 ? "" : "s"} to finish: ${titles.join(", ")}${more}.`;
    });

  /** Closes the admission gate the moment this host is idle; woken by run events, never a timer. */
  const closeGateWhenIdle = (record: HostDeploymentRecord) =>
    Effect.gen(function* () {
      const gateReason = `This host is installing ${record.request.version}; new work can start after it restarts.`;
      let afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
      while (true) {
        const result = yield* gate.closeWhenIdle(gateReason).pipe(Effect.orDie);
        if (result.closed) return;
        yield* setStep(
          record.request.releaseId,
          "waiting",
          "idle",
          yield* blockingRunReason(result.blocking),
        );
        const ended = yield* eventSink.stream({ eventType: "run.updated", afterSequence }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              !BLOCKING_RUN_STATUSES.has(stored.event.payload.status),
          ),
          Stream.runHead,
          Effect.orDie,
        );
        if (Option.isSome(ended)) afterSequence = ended.value.sequence;
      }
    });

  const reopenGate = gate.open.pipe(
    Effect.andThen(orchestrator.resumeQueuedRuns),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not resume queued runs after a deployment.", { cause }),
    ),
  );

  const finish = (
    releaseId: string,
    status: "blocked" | "failed",
    step: HostDeploymentStep,
    reason: string,
  ) =>
    // Release the updater first, so a user acting on the stopped state is not refused.
    desktopAppUpdate
      .reserve(undefined)
      .pipe(Effect.andThen(setStep(releaseId, status, step, reason)));

  /**
   * The gated part: wait for idle and close the gate, back up, then hand off
   * to the desktop installer. `handoff.committing` tells the caller the
   * process is being replaced, so nothing should be released.
   */
  const install = (releaseId: string, handoff: { committing: boolean }) =>
    Effect.gen(function* () {
      // Prepare failures mean the feed changed (blocked); later ones are failed attempts.
      let phase: "prepare" | "backup" | "commit" = "prepare";
      let prepared: string | undefined;
      yield* Effect.gen(function* () {
        const record = yield* requireRecord(releaseId).pipe(Effect.orDie);
        yield* setStep(releaseId, "waiting", "idle", "Waiting for this host to be idle.");
        yield* closeGateWhenIdle(record);
        yield* setStep(
          releaseId,
          "installing",
          "backup",
          `Backing up state before installing ${record.request.version}.`,
        );
        const token = yield* prepare(record);
        prepared = token;
        phase = "backup";
        const from = record.from ?? (yield* host.runtimeIdentity);
        const backup = yield* host.backup({ releaseId, from }).pipe(
          Effect.timeoutOrElse({
            duration: BACKUP_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new HostDeploymentBlocked({ reason: "The state backup did not finish in time." }),
              ),
          }),
        );
        yield* host.pruneBackups(BACKUPS_KEPT);
        phase = "commit";
        yield* update(releaseId, (current) => ({
          ...current,
          status: "installing",
          step: "commit",
          reason: `Installing ${current.request.version}; the app restarts.`,
          from,
          backup,
        }));
        handoff.committing = true;
        // Success replaces this process; this returns only on failure.
        return yield* desktopAppUpdate.commit(token, undefined, { deployment: releaseId });
      }).pipe(
        // Reopen before recording the outcome, so a stopped deployment never holds the gate.
        Effect.catch((cause) =>
          reopenGate.pipe(
            // A failed backup leaves the preparation uncommitted; free it for a retry.
            Effect.andThen(
              phase === "backup" && prepared !== undefined
                ? desktopAppUpdate.release(prepared)
                : Effect.void,
            ),
            Effect.andThen(
              finish(
                releaseId,
                phase === "prepare" ? "blocked" : "failed",
                phase === "commit" ? "commit" : "backup",
                cause.reason,
              ),
            ),
          ),
        ),
        // A shutdown during the hand-off is the install itself; a cancel or defect reopens.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || (handoff.committing && isInterruption(exit))
            ? Effect.void
            : reopenGate,
        ),
      );
    });

  const markVerified = (
    releaseId: string,
    runtime: HostDeploymentIdentity,
    reason: string | null,
  ) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      return yield* update(releaseId, (record) => ({
        ...record,
        status: record.request.automaticAcceptance ? "accepted" : "verified",
        acceptance: record.request.automaticAcceptance
          ? {
              scope: record.request.acceptanceScope,
              summary:
                reason ?? "Restart checks passed: version, commit, signing, data and settings.",
              evidence: null,
              at,
            }
          : record.acceptance,
        step: "verify",
        reason,
        runtime,
        milestones: {
          ...record.milestones,
          installedAt: record.milestones.installedAt ?? at,
          verifiedAt: at,
          acceptedAt: record.request.automaticAcceptance ? at : record.milestones.acceptedAt,
        },
      }));
    });

  const drive = (releaseId: string) => {
    const handoff = { committing: false };
    return Effect.gen(function* () {
      yield* desktopAppUpdate.reserve(releaseId);
      let record = yield* setStep(releaseId, "preparing", "preflight", "Checking this host.");
      const runtime = yield* host.runtimeIdentity;
      if (
        runtime.version === record.request.version &&
        commitMatches(runtime.commit, record.request.commit)
      ) {
        yield* markVerified(releaseId, runtime, "This host already runs this release.");
        return;
      }
      const preflight = yield* host.preflight(record.request).pipe(Effect.result);
      if (preflight._tag === "Failure") {
        yield* finish(releaseId, "blocked", "preflight", preflight.failure.reason);
        return;
      }
      record = yield* update(releaseId, (current) => ({
        ...current,
        from: runtime,
        step: "download",
        reason: `Downloading ${current.request.version}.`,
      }));
      const downloaded = yield* prepare(record).pipe(Effect.result);
      if (downloaded._tag === "Failure") {
        yield* finish(releaseId, "blocked", "download", downloaded.failure.reason);
        return;
      }
      // The install re-prepares under the gate; this check's preparation would refuse it.
      yield* desktopAppUpdate.release(downloaded.success);
      const publishedAt = yield* nowIso;
      record = yield* update(releaseId, (current) => ({
        ...current,
        milestones: { ...current.milestones, publishedAt },
      }));

      if (record.role === "local" && record.admission === null) {
        yield* setStep(
          releaseId,
          "waiting",
          "admission",
          "Waiting for the remote hosts to verify this release, or a local-only override.",
        );
        yield* SubscriptionRef.changes(records).pipe(
          Stream.filter((all) =>
            all.some((entry) => entry.request.releaseId === releaseId && entry.admission !== null),
          ),
          Stream.runHead,
        );
      }
      yield* install(releaseId, handoff);
    }).pipe(
      Effect.onExit((exit) =>
        handoff.committing && isInterruption(exit)
          ? Effect.void
          : desktopAppUpdate.reserve(undefined),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("Release deployment driver failed.", { releaseId, cause }).pipe(
              Effect.andThen(find(releaseId)),
              Effect.flatMap((current) =>
                finish(
                  releaseId,
                  "failed",
                  current?.step ?? "preflight",
                  "The deployment stopped unexpectedly; see the server log.",
                ),
              ),
              Effect.ignore,
            ),
      ),
    );
  };

  const startDriver = (releaseId: string) =>
    FiberMap.run(drivers, releaseId, drive(releaseId), { onlyIfMissing: true });

  /** After a restart: verify a committed install, fail an interrupted backup, resume the rest. */
  const reconcile = (left: ReadonlyArray<HostDeploymentRecord>) =>
    Effect.gen(function* () {
      for (const record of left) {
        const releaseId = record.request.releaseId;
        if (record.status === "installing" && record.step === "commit") {
          const runtime = yield* host.runtimeIdentity;
          const expected = `${record.request.version} (${record.request.commit.slice(0, 12)})`;
          if (
            runtime.version !== record.request.version ||
            !commitMatches(runtime.commit, record.request.commit)
          ) {
            yield* update(releaseId, (current) => ({
              ...current,
              status: "failed",
              step: "verify",
              runtime,
              reason: `Restarted on ${describeIdentity(runtime)}; expected ${expected}. The state backup is at ${current.backup?.path ?? "an unknown path"}.`,
            }));
            continue;
          }
          const installedAt = yield* nowIso;
          yield* update(releaseId, (current) => ({
            ...current,
            runtime,
            milestones: { ...current.milestones, installedAt },
          }));
          const problems: Array<string> = [];
          if (record.from?.signing != null && runtime.signing !== record.from.signing) {
            problems.push(
              `the new app is signed by ${runtime.signing ?? "nobody"}, not ${record.from.signing}`,
            );
          }
          const counts = yield* host.liveCounts.pipe(Effect.result);
          if (counts._tag === "Failure") problems.push(counts.failure.reason);
          else if (
            record.backup !== null &&
            (counts.success.threadCount < record.backup.threadCount ||
              counts.success.projectCount < record.backup.projectCount)
          ) {
            problems.push(
              `${counts.success.threadCount} threads and ${counts.success.projectCount} projects remain; the backup had ${record.backup.threadCount} and ${record.backup.projectCount}`,
            );
          }
          if (!(yield* host.settingsReadable)) problems.push("settings.json no longer parses");
          if (problems.length > 0) {
            yield* finish(releaseId, "failed", "verify", `Installed, but ${problems.join("; ")}.`);
          } else {
            yield* markVerified(releaseId, runtime, null);
          }
        } else if (record.status === "installing") {
          yield* finish(
            releaseId,
            "failed",
            record.step,
            "The host restarted before the install was handed off; the app was not replaced. Retry to start again.",
          );
        } else if (record.status === "preparing" || record.status === "waiting") {
          yield* startDriver(releaseId);
        } else if (record.status === "blocked" || record.status === "failed") {
          // Installed another way after it stopped, e.g. by hand: the release is satisfied.
          const runtime = yield* host.runtimeIdentity;
          if (
            runtime.version === record.request.version &&
            commitMatches(runtime.commit, record.request.commit)
          ) {
            yield* markVerified(releaseId, runtime, "This host already runs this release.");
          }
        }
      }
    });

  // Only what the previous process left; requests made after startup own their drivers.
  yield* reconcile(yield* SubscriptionRef.get(records)).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Could not reconcile release deployments.", { cause }),
    ),
    Effect.forkScoped,
  );

  const activeOther = (releaseId: string) =>
    SubscriptionRef.get(records).pipe(
      Effect.map((all) =>
        all.find(
          (record) => record.request.releaseId !== releaseId && ACTIVE_STATUSES.has(record.status),
        ),
      ),
    );

  const request: HostDeploymentShape["request"] = (input) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const target = input.targets.find((entry) => entry.environmentId === environmentId);
        if (target === undefined) {
          return yield* error("This host is not one of the release's targets.", input.releaseId);
        }
        if (input.targets.filter((entry) => entry.role === "local").length > 1) {
          return yield* error("A release can install on at most one local host.", input.releaseId);
        }
        if (input.releaseId !== input.version) {
          return yield* error("A release is identified by its version.", input.releaseId);
        }
        const existing = yield* find(input.releaseId);
        if (existing !== undefined) {
          if (!sameIdentity(existing.request, input)) {
            return yield* error(
              `Release ${input.releaseId} was already approved with a different commit or artifact.`,
              input.releaseId,
            );
          }
          return existing;
        }
        const other = yield* activeOther(input.releaseId);
        if (other !== undefined) {
          return yield* error(
            `Release ${other.request.releaseId} is already deploying on this host; cancel it first.`,
            input.releaseId,
          );
        }
        const record = yield* persist({
          request: input,
          environmentId,
          role: target.role,
          status: "preparing",
          step: "preflight",
          reason: null,
          from: null,
          runtime: null,
          milestones: {
            approvedAt: input.approvedAt,
            publishedAt: null,
            installedAt: null,
            verifiedAt: null,
            acceptedAt: null,
          },
          admission: null,
          backup: null,
          acceptance: null,
          updatedAt: input.approvedAt,
        });
        yield* startDriver(input.releaseId);
        return record;
      }),
    );

  const admit: HostDeploymentShape["admit"] = (input) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(input.releaseId);
      if (record.role !== "local") {
        return yield* error("Only the local host waits for admission.", input.releaseId);
      }
      // A repeated admit is a no-op, so a client can resume its sequence safely.
      if (record.admission !== null || !ACTIVE_STATUSES.has(record.status)) return record;
      const at = yield* nowIso;
      return yield* update(input.releaseId, (current) => ({
        ...current,
        admission: { mode: input.mode, evidence: input.evidence, at },
      }));
    });

  const cancel: HostDeploymentShape["cancel"] = (releaseId) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(releaseId);
      if (isHostDeploymentTerminal(record.status) || record.status === "verified") return record;
      if (record.status === "installing" && record.step === "commit") {
        return yield* error("The install was already handed to the desktop app.", releaseId);
      }
      // Interrupting the driver reopens the gate and releases the updater.
      yield* FiberMap.remove(drivers, releaseId);
      return yield* setStep(releaseId, "cancelled", record.step, "Cancelled.");
    });

  const retry: HostDeploymentShape["retry"] = (releaseId) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* requireRecord(releaseId);
        if (!["blocked", "failed", "cancelled"].includes(record.status)) {
          return yield* error(
            `Deployment ${releaseId} is ${record.status}; only a stopped deployment can be retried.`,
            releaseId,
          );
        }
        const other = yield* activeOther(releaseId);
        if (other !== undefined) {
          return yield* error(
            `Release ${other.request.releaseId} is already deploying on this host; cancel it first.`,
            releaseId,
          );
        }
        const next = yield* persist({
          ...record,
          status: "preparing",
          step: "preflight",
          reason: null,
          admission: null,
        });
        yield* startDriver(releaseId);
        return next;
      }),
    );

  const recordAcceptance: HostDeploymentShape["recordAcceptance"] = (input) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(input.releaseId);
      if (record.status === "accepted") return record;
      if (record.status !== "verified") {
        return yield* error(
          `Acceptance needs a verified install; ${input.releaseId} is ${record.status}.`,
          input.releaseId,
        );
      }
      if (input.scope !== record.request.acceptanceScope) {
        return yield* error(
          `The receipt must confirm the approved scope: "${record.request.acceptanceScope}".`,
          input.releaseId,
        );
      }
      const at = yield* nowIso;
      return yield* update(input.releaseId, (current) => ({
        ...current,
        status: "accepted",
        reason: null,
        acceptance: {
          scope: input.scope,
          summary: input.summary,
          evidence: input.evidence ?? null,
          at,
        },
        milestones: { ...current.milestones, acceptedAt: at },
      }));
    });

  return HostDeployment.of({
    request,
    admit,
    retry,
    cancel,
    recordAcceptance,
    list: SubscriptionRef.get(records),
    subscribe: SubscriptionRef.changes(records).pipe(
      Stream.map((deployments) => ({ deployments })),
    ),
  });
});

export const layer = Layer.effect(HostDeployment, make);
