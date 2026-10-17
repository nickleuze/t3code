import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  HostDeployment as HostDeploymentRecord,
  type HostDeploymentBackup,
  type HostDeploymentIdentity,
  type HostDeploymentRequest,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ServerSelfUpdateError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RunAdmissionGate from "../orchestration-v2/RunAdmissionGate.ts";
import * as HostDeployment from "./HostDeployment.ts";
import { HostDeploymentBlocked, HostDeploymentHost } from "./HostDeploymentHost.ts";

const MINI = EnvironmentId.make("env-mini");
const MACBOOK = EnvironmentId.make("env-macbook");
const RELEASE = "0.0.46-nick.22";
const COMMIT = "abcdef1234567890abcdef1234567890abcdef12";
const SHA512 = "sha512-approved";

const FROM: HostDeploymentIdentity = {
  version: "0.0.46-nick.21",
  commit: "0123456789ab",
  signing: "Developer ID Application: Nick (TEAM)",
};
const TARGET: HostDeploymentIdentity = { ...FROM, version: RELEASE, commit: COMMIT.slice(0, 12) };

function makeRequest(overrides: Partial<HostDeploymentRequest> = {}): HostDeploymentRequest {
  return {
    releaseId: RELEASE,
    version: RELEASE,
    commit: COMMIT,
    artifactSha256: "sha256-approved",
    artifactSha512: SHA512,
    feed: { owner: "nickleuze", repo: "t3code" },
    acceptanceScope: "Project creation works",
    targets: [
      { environmentId: MINI, label: "Mini", role: "remote" },
      { environmentId: MACBOOK, label: "MacBook", role: "local" },
    ],
    approvedAt: "2026-10-17T12:00:00.000Z",
    ...overrides,
  };
}

const BACKUP: HostDeploymentBackup = {
  path: "/backups/0.0.46-nick.22",
  databaseBytes: 1024,
  threadCount: 10,
  projectCount: 2,
  appBundle: { path: "/backups/0.0.46-nick.22/T3 Code.app", version: FROM.version },
  verifiedAt: "2026-10-17T12:05:00.000Z",
};

/** Mutable knobs and call log shared by the fakes. */
interface Fakes {
  runtime: HostDeploymentIdentity;
  offeredVersion: string;
  offeredSha512: string | undefined;
  preflightBlock: string | undefined;
  backupFailure: string | undefined;
  commit: "fail" | "never";
  liveCounts: { threadCount: number; projectCount: number };
  runs: number;
  commits: number;
  prunes: Array<number>;
  reservations: Array<string | undefined>;
  resumes: number;
}

function makeFakes(overrides: Partial<Fakes> = {}): Fakes {
  return {
    runtime: FROM,
    offeredVersion: RELEASE,
    offeredSha512: SHA512,
    preflightBlock: undefined,
    backupFailure: undefined,
    commit: "fail",
    liveCounts: { threadCount: 10, projectCount: 2 },
    runs: 0,
    commits: 0,
    prunes: [],
    reservations: [],
    resumes: 0,
    ...overrides,
  };
}

function makeLayer(fakes: Fakes, environmentId: EnvironmentId = MINI) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerStores = Layer.mergeAll(
    layerDatabase,
    EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
    ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  );
  const layerGate = RunAdmissionGate.layer.pipe(Layer.provide(layerDatabase));
  return Layer.mergeAll(
    layerStores,
    layerGate,
    EventSink.layer.pipe(Layer.provide(Layer.merge(layerStores, layerGate))),
    Layer.mock(OrchestratorV2)({
      resumeQueuedRuns: Effect.sync(() => {
        fakes.resumes += 1;
        return 0;
      }),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.succeed(
      DesktopAppUpdate.DesktopAppUpdate,
      DesktopAppUpdate.DesktopAppUpdate.of({
        available: true,
        run: () =>
          Effect.sync(() => {
            fakes.runs += 1;
            return {
              targetVersion: fakes.offeredVersion,
              method: "desktop-app" as const,
              desktopUpdateToken: `token-${fakes.runs}`,
              ...(fakes.offeredSha512 === undefined
                ? {}
                : { downloadedSha512: fakes.offeredSha512 }),
            };
          }),
        commit: () =>
          Effect.suspend(() => {
            fakes.commits += 1;
            return fakes.commit === "never"
              ? Effect.never
              : Effect.fail(new ServerSelfUpdateError({ reason: "Normal Quit timed out." }));
          }),
        reserve: (deployment) => Effect.sync(() => void fakes.reservations.push(deployment)),
      }),
    ),
    Layer.succeed(
      HostDeploymentHost,
      HostDeploymentHost.of({
        runtimeIdentity: Effect.sync(() => fakes.runtime),
        preflight: () =>
          fakes.preflightBlock === undefined
            ? Effect.void
            : Effect.fail(new HostDeploymentBlocked({ reason: fakes.preflightBlock })),
        backup: () =>
          fakes.backupFailure === undefined
            ? Effect.succeed(BACKUP)
            : Effect.fail(new HostDeploymentBlocked({ reason: fakes.backupFailure })),
        pruneBackups: (keep) => Effect.sync(() => void fakes.prunes.push(keep)),
        liveCounts: Effect.sync(() => fakes.liveCounts),
        settingsReadable: Effect.succeed(true),
      }),
    ),
  );
}

/** Waits on the service's own change stream; no sleeps or polling. */
const awaitRecord = (predicate: (record: HostDeploymentRecord) => boolean) =>
  Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    const found = yield* deployments.subscribe.pipe(
      Stream.map((list) => list.deployments.find(predicate)),
      Stream.filter((record): record is HostDeploymentRecord => record !== undefined),
      Stream.runHead,
    );
    return Option.getOrThrow(found);
  });

const providerInstanceId = ProviderInstanceId.make("codex");

function runEvent(
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  now: DateTime.Utc,
  type: "run.created" | "run.updated",
): OrchestrationV2DomainEvent {
  const runId = RunId.make(`run:${threadId}`);
  return {
    id: EventId.make(`event:${threadId}:${type}:${status}`),
    type,
    threadId,
    runId,
    providerInstanceId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${threadId}`),
      rootNodeId: null,
      activeAttemptId: RunAttemptId.make(`attempt:${threadId}`),
      status,
      queuePosition: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

function threadEvent(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:${threadId}:thread`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:deploy"),
      title: "Busy thread",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(HostDeploymentRecord));

/** A record as a previous process left it, written before the service starts. */
const seed = (overrides: Partial<HostDeploymentRecord>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* HostDeployment.bootstrapSchema;
    const record: HostDeploymentRecord = {
      request: makeRequest(),
      environmentId: MINI,
      role: "remote",
      status: "installing",
      step: "commit",
      reason: null,
      from: FROM,
      runtime: null,
      milestones: {
        approvedAt: "2026-10-17T12:00:00.000Z",
        publishedAt: "2026-10-17T12:01:00.000Z",
        installedAt: null,
        verifiedAt: null,
        acceptedAt: null,
      },
      admission: null,
      backup: BACKUP,
      acceptance: null,
      updatedAt: "2026-10-17T12:05:00.000Z",
      ...overrides,
    };
    yield* sql`
      INSERT INTO fork_host_deployments (release_id, status, record_json, updated_at)
      VALUES (${RELEASE}, ${record.status}, ${encodeRecord(record)}, ${record.updatedAt})
    `;
  });

it.effect("backs up and hands off once idle; a failed quit reopens the gate", () => {
  const fakes = makeFakes();
  return Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    const gate = yield* RunAdmissionGate.RunAdmissionGate;
    yield* deployments.request(makeRequest());
    const failed = yield* awaitRecord((record) => record.status === "failed");
    assert.strictEqual(failed.step, "commit");
    assert.strictEqual(failed.reason, "Normal Quit timed out.");
    assert.deepEqual(failed.backup, BACKUP);
    assert.isNotNull(failed.milestones.publishedAt);
    assert.isNull(failed.milestones.installedAt);
    assert.strictEqual(fakes.commits, 1);
    assert.deepEqual(fakes.prunes, [2]);
    assert.isUndefined(yield* gate.closedReason);
    assert.strictEqual(fakes.resumes, 1);
    assert.strictEqual(fakes.reservations[0], RELEASE);
    assert.isUndefined(fakes.reservations.at(-1));
  }).pipe(Effect.provide(HostDeployment.layer), Effect.provide(makeLayer(fakes)));
});

it.effect("a backup failure never commits and reopens the gate", () => {
  const fakes = makeFakes({
    backupFailure: "The state backup failed its integrity check (corrupt).",
  });
  return Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    const gate = yield* RunAdmissionGate.RunAdmissionGate;
    yield* deployments.request(makeRequest());
    const failed = yield* awaitRecord((record) => record.status === "failed");
    assert.strictEqual(failed.step, "backup");
    assert.include(failed.reason ?? "", "integrity check");
    assert.strictEqual(fakes.commits, 0);
    assert.isUndefined(yield* gate.closedReason);
  }).pipe(Effect.provide(HostDeployment.layer), Effect.provide(makeLayer(fakes)));
});

it.effect("waits for active runs, then gates new admissions while installing", () => {
  const fakes = makeFakes({ commit: "never" });
  return Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    const eventSink = yield* EventSink.EventSinkV2;
    const gate = yield* RunAdmissionGate.RunAdmissionGate;
    const now = yield* DateTime.now;
    const busy = ThreadId.make("thread:busy");
    yield* eventSink.write({
      events: [threadEvent(busy, now), runEvent(busy, "running", now, "run.created")],
    });

    yield* deployments.request(makeRequest());
    const waiting = yield* awaitRecord(
      (record) =>
        record.status === "waiting" &&
        record.step === "idle" &&
        record.reason !== "Waiting for this host to be idle.",
    );
    assert.include(waiting.reason ?? "", 'Waiting for 1 active run to finish: "Busy thread"');
    assert.isUndefined(yield* gate.closedReason);
    assert.strictEqual(fakes.commits, 0);

    // The existing run finishes on its own; nothing interrupts it.
    yield* eventSink.write({ events: [runEvent(busy, "completed", now, "run.updated")] });
    yield* awaitRecord((record) => record.step === "commit");
    assert.include((yield* gate.closedReason) ?? "", `installing ${RELEASE}`);

    const idle = ThreadId.make("thread:new-work");
    yield* eventSink.write({ events: [threadEvent(idle, now)] });
    const rejected = yield* eventSink
      .write({ events: [runEvent(idle, "starting", now, "run.created")] })
      .pipe(Effect.flip);
    assert.isTrue(RunAdmissionGate.isRunAdmissionClosed(rejected));
  }).pipe(Effect.provide(HostDeployment.layer), Effect.provide(makeLayer(fakes)));
});

it.effect("treats a repeated request as the same deployment and rejects a changed identity", () => {
  const fakes = makeFakes({ commit: "never" });
  return Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    const first = yield* deployments.request(makeRequest());
    const again = yield* deployments.request(makeRequest());
    assert.strictEqual(again.request.releaseId, first.request.releaseId);
    yield* awaitRecord((record) => record.step === "commit");
    // One driver: one download and one re-prepare before the commit.
    assert.strictEqual(fakes.runs, 2);

    const conflict = yield* deployments
      .request(makeRequest({ commit: "fedcba9876543210" }))
      .pipe(Effect.flip);
    assert.include(conflict.message, "different commit or artifact");
    const other = yield* deployments
      .request(makeRequest({ releaseId: "0.0.46-nick.23", version: "0.0.46-nick.23" }))
      .pipe(Effect.flip);
    assert.include(other.message, `Release ${RELEASE} is already deploying`);
  }).pipe(Effect.provide(HostDeployment.layer), Effect.provide(makeLayer(fakes)));
});

it.effect("blocks when the feed offers another version or artifact", () => {
  const fakes = makeFakes({ offeredVersion: "0.0.46-nick.23" });
  return Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    yield* deployments.request(makeRequest());
    const blocked = yield* awaitRecord((record) => record.status === "blocked");
    assert.strictEqual(blocked.step, "download");
    assert.include(blocked.reason ?? "", "now offers 0.0.46-nick.23");

    fakes.offeredVersion = RELEASE;
    fakes.offeredSha512 = "sha512-other";
    yield* deployments.retry(RELEASE);
    const mismatch = yield* awaitRecord(
      (record) => record.status === "blocked" && (record.reason ?? "").includes("digest"),
    );
    assert.strictEqual(mismatch.step, "download");
    assert.strictEqual(fakes.commits, 0);
  }).pipe(Effect.provide(HostDeployment.layer), Effect.provide(makeLayer(fakes)));
});

it.effect("blocks on a failed preflight with its reason", () => {
  const fakes = makeFakes({ preflightBlock: "The backup needs 9 GiB free; 2 GiB is available." });
  return Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    yield* deployments.request(makeRequest());
    const blocked = yield* awaitRecord((record) => record.status === "blocked");
    assert.strictEqual(blocked.step, "preflight");
    assert.strictEqual(blocked.reason, fakes.preflightBlock);
    assert.strictEqual(fakes.runs, 0);
  }).pipe(Effect.provide(HostDeployment.layer), Effect.provide(makeLayer(fakes)));
});

it.effect("holds the local host at admission until it is admitted", () => {
  const fakes = makeFakes({ commit: "never" });
  return Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    const gate = yield* RunAdmissionGate.RunAdmissionGate;
    yield* deployments.request(makeRequest());
    yield* awaitRecord((record) => record.step === "admission");
    assert.isUndefined(yield* gate.closedReason);
    assert.strictEqual(fakes.commits, 0);

    yield* deployments.admit({
      releaseId: RELEASE,
      mode: "local-only",
      evidence: "Mini is offline; installing here anyway.",
    });
    // A late duplicate admit changes nothing.
    yield* deployments.admit({
      releaseId: RELEASE,
      mode: "remotes-verified",
      evidence: "Mini verified",
    });
    const committing = yield* awaitRecord((record) => record.step === "commit");
    assert.strictEqual(committing.admission?.mode, "local-only");
    assert.strictEqual(committing.role, "local");
  }).pipe(Effect.provide(HostDeployment.layer), Effect.provide(makeLayer(fakes, MACBOOK)));
});

it.effect("cancelling while waiting reopens the gate and releases the updater", () => {
  const fakes = makeFakes();
  return Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    const gate = yield* RunAdmissionGate.RunAdmissionGate;
    yield* deployments.request(makeRequest());
    yield* awaitRecord((record) => record.step === "admission");
    const cancelled = yield* deployments.cancel(RELEASE);
    assert.strictEqual(cancelled.status, "cancelled");
    assert.isUndefined(yield* gate.closedReason);
    assert.deepEqual(fakes.reservations, [RELEASE, undefined]);
  }).pipe(Effect.provide(HostDeployment.layer), Effect.provide(makeLayer(fakes, MACBOOK)));
});

it.effect("verifies a committed install after the restart, then records acceptance", () => {
  const fakes = makeFakes({ runtime: TARGET });
  return Effect.gen(function* () {
    yield* seed({});
    yield* Effect.gen(function* () {
      const deployments = yield* HostDeployment.HostDeployment;
      const verified = yield* awaitRecord((record) => record.status === "verified");
      assert.deepEqual(verified.runtime, TARGET);
      assert.isNotNull(verified.milestones.installedAt);
      assert.isNotNull(verified.milestones.verifiedAt);
      assert.isNull(verified.milestones.acceptedAt);
      assert.strictEqual(fakes.commits, 0);

      const wrongScope = yield* deployments
        .recordAcceptance({ releaseId: RELEASE, scope: "Something else", summary: "ok" })
        .pipe(Effect.flip);
      assert.include(wrongScope.message, "Project creation works");
      const accepted = yield* deployments.recordAcceptance({
        releaseId: RELEASE,
        scope: "Project creation works",
        summary: "Created a project from the sidebar on the Mini.",
      });
      assert.strictEqual(accepted.status, "accepted");
      assert.isNotNull(accepted.milestones.acceptedAt);
    }).pipe(Effect.provide(HostDeployment.layer));
  }).pipe(Effect.provide(makeLayer(fakes)));
});

it.effect("fails a restart onto the wrong version without committing again", () => {
  const fakes = makeFakes({ runtime: FROM });
  return Effect.gen(function* () {
    yield* seed({});
    yield* Effect.gen(function* () {
      const failed = yield* awaitRecord((record) => record.status === "failed");
      assert.strictEqual(failed.step, "verify");
      assert.include(
        failed.reason ?? "",
        `Restarted on ${FROM.version} (${FROM.commit}); expected ${RELEASE} (${COMMIT.slice(0, 12)})`,
      );
      assert.strictEqual(fakes.commits, 0);
      assert.strictEqual(fakes.runs, 0);
    }).pipe(Effect.provide(HostDeployment.layer));
  }).pipe(Effect.provide(makeLayer(fakes)));
});

it.effect("fails verification when data did not survive the install", () => {
  const fakes = makeFakes({ runtime: TARGET, liveCounts: { threadCount: 3, projectCount: 2 } });
  return Effect.gen(function* () {
    yield* seed({});
    yield* Effect.gen(function* () {
      const failed = yield* awaitRecord((record) => record.status === "failed");
      assert.include(
        failed.reason ?? "",
        "3 threads and 2 projects remain; the backup had 10 and 2",
      );
      assert.isNotNull(failed.milestones.installedAt);
    }).pipe(Effect.provide(HostDeployment.layer));
  }).pipe(Effect.provide(makeLayer(fakes)));
});

it.effect("fails an install interrupted before the hand-off instead of replaying it", () => {
  const fakes = makeFakes();
  return Effect.gen(function* () {
    yield* seed({ step: "backup", backup: null });
    yield* Effect.gen(function* () {
      const failed = yield* awaitRecord((record) => record.status === "failed");
      assert.include(failed.reason ?? "", "the app was not replaced");
      assert.strictEqual(fakes.commits, 0);
    }).pipe(Effect.provide(HostDeployment.layer));
  }).pipe(Effect.provide(makeLayer(fakes)));
});

it.effect("verifies at once when the host already runs the release", () => {
  const fakes = makeFakes({ runtime: TARGET });
  return Effect.gen(function* () {
    const deployments = yield* HostDeployment.HostDeployment;
    yield* deployments.request(makeRequest());
    const verified = yield* awaitRecord((record) => record.status === "verified");
    assert.strictEqual(verified.reason, "This host already runs this release.");
    assert.strictEqual(fakes.runs, 0);
  }).pipe(Effect.provide(HostDeployment.layer), Effect.provide(makeLayer(fakes)));
});
