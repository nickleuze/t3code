// @effect-diagnostics nodeBuiltinImport:off - statfs and the SQLite backup API have no Effect equivalent.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import type {
  HostDeploymentArtifact,
  HostDeploymentBackup,
  HostDeploymentIdentity,
  HostDeploymentRequest,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

/** A host condition that stops a deployment until the user acts; `reason` says what to do. */
export class HostDeploymentBlocked extends Schema.TaggedError<HostDeploymentBlocked>()(
  "HostDeploymentBlocked",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface LiveCounts {
  readonly threadCount: number;
  readonly projectCount: number;
}

/**
 * The host side of a release deployment: identity, preflight, backups and
 * retention on macOS and Windows. Everything that touches the filesystem,
 * `codesign` or SQLite files lives here so the deployment state machine stays
 * testable.
 */
export interface HostDeploymentHostShape {
  readonly runtimeIdentity: Effect.Effect<HostDeploymentIdentity>;
  /** The release file this host's updater downloads, or null when the release has none. */
  readonly approvedArtifact: (request: HostDeploymentRequest) => HostDeploymentArtifact | null;
  readonly preflight: (
    request: HostDeploymentRequest,
  ) => Effect.Effect<void, HostDeploymentBlocked>;
  /** Consistent state/settings snapshot plus a copy of the running app, verified. */
  readonly backup: (input: {
    readonly releaseId: string;
    readonly from: HostDeploymentIdentity;
  }) => Effect.Effect<HostDeploymentBackup, HostDeploymentBlocked>;
  /** Moves verified backups beyond the newest `keep` to the Trash (Recycle Bin on Windows). */
  readonly pruneBackups: (keep: number) => Effect.Effect<void>;
  readonly liveCounts: Effect.Effect<LiveCounts, HostDeploymentBlocked>;
  /** False when settings.json exists but no longer parses. */
  readonly settingsReadable: Effect.Effect<boolean>;
}

export class HostDeploymentHost extends Context.Service<
  HostDeploymentHost,
  HostDeploymentHostShape
>()("t3/deploy/HostDeploymentHost") {}

const BACKUP_DIRECTORY = "deploy-backups";
const BACKUP_MANIFEST = "deployment-backup.json";
const FREE_SPACE_MARGIN_BYTES = 512 * 1024 * 1024;

const BackupManifest = Schema.Struct({
  releaseId: Schema.String,
  verifiedAt: Schema.String,
});
const decodeBackupManifest = Schema.decodeUnknownOption(Schema.fromJsonString(BackupManifest));
const encodeBackupManifest = Schema.encodeSync(Schema.fromJsonString(BackupManifest));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const parsesAsJson = (raw: string) => Option.isSome(decodeJson(raw));

/** The macOS zip or the Windows installer; other platforms have no release build. */
export function approvedArtifact(
  request: HostDeploymentRequest,
  platform: NodeJS.Platform,
): HostDeploymentArtifact | null {
  if (platform === "darwin") {
    return { sha256: request.artifactSha256, sha512: request.artifactSha512 };
  }
  return platform === "win32" ? (request.windowsArtifact ?? null) : null;
}

/** `owner` and `repo` from electron-builder's `app-update.yml`. */
export function parseAppUpdateFeed(
  raw: string,
): { readonly owner: string; readonly repo: string } | null {
  const value = (key: string) =>
    raw
      .split("\n")
      .map((line) => line.match(new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`))?.[1])
      .find((match) => match !== undefined);
  const owner = value("owner");
  const repo = value("repo");
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

/** `Authority (TeamIdentifier)` from `codesign -dv --verbose=2` output. */
export function parseSigningIdentity(output: string): string | null {
  const authority = output.match(/^Authority=(.+)$/m)?.[1]?.trim();
  const team = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (authority === undefined) return null;
  return team === undefined || team === "not set" || authority.includes(`(${team})`)
    ? authority
    : `${authority} (${team})`;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const sql = yield* SqlClient.SqlClient;
  const platform = yield* HostProcess.Platform;
  const isMac = platform === "darwin";

  const backupRoot = path.join(config.baseDir, BACKUP_DIRECTORY);
  const blocked = (reason: string) => (cause: unknown) =>
    new HostDeploymentBlocked({ reason, cause });

  const run = (
    command: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Input = "2 minutes",
  ) => runner.run({ command, args, timeout, outputMode: "truncate" });

  const signingOf = (bundle: string) =>
    run("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]).pipe(
      Effect.map((result) => (result.code === 0 ? parseSigningIdentity(result.stderr) : null)),
      Effect.orElseSucceed(() => null),
    );

  const runtimeIdentity = Effect.gen(function* () {
    return {
      version: packageJson.version,
      commit: config.appCommitHash ?? null,
      // Windows builds are unsigned.
      signing:
        !isMac || config.appBundlePath === undefined
          ? null
          : yield* signingOf(config.appBundlePath),
    } satisfies HostDeploymentIdentity;
  });

  const directoryBytes = (target: string) =>
    run("/usr/bin/du", ["-sk", target]).pipe(
      Effect.map(
        (result) => Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "", 10) * 1024,
      ),
      Effect.map((bytes) => (Number.isFinite(bytes) ? bytes : 0)),
      Effect.orElseSucceed(() => 0),
    );

  const preflight: HostDeploymentHostShape["preflight"] = (request) =>
    Effect.gen(function* () {
      const bundle = config.appBundlePath;
      if ((!isMac && platform !== "win32") || bundle === undefined) {
        return yield* new HostDeploymentBlocked({
          reason:
            "Release deployment installs the packaged desktop app, which this host is not running.",
        });
      }
      if (config.appCommitHash === undefined) {
        return yield* new HostDeploymentBlocked({
          reason:
            "This app build does not report its commit, so the installed release cannot be verified.",
        });
      }

      const feedFile = isMac
        ? path.join(bundle, "Contents", "Resources", "app-update.yml")
        : path.join(bundle, "resources", "app-update.yml");
      const feed = parseAppUpdateFeed(
        yield* fs
          .readFileString(feedFile)
          .pipe(Effect.mapError(blocked(`Could not read ${feedFile}.`))),
      );
      if (feed?.owner !== request.feed.owner || feed.repo !== request.feed.repo) {
        return yield* new HostDeploymentBlocked({
          reason: `This app updates from ${feed === null ? "an unknown feed" : `${feed.owner}/${feed.repo}`}, not the release's ${request.feed.owner}/${request.feed.repo}.`,
        });
      }

      // The unsigned Windows build has no signature, and its updater checks none.
      if (isMac) {
        const verify = yield* run("/usr/bin/codesign", [
          "--verify",
          "--deep",
          "--strict",
          bundle,
        ]).pipe(Effect.mapError(blocked("Could not run codesign to check the running app.")));
        if (verify.code !== 0 || (yield* signingOf(bundle)) === null) {
          return yield* new HostDeploymentBlocked({
            reason:
              "The running app's code signature is not valid, so the updater would reject the new release.",
          });
        }
      }

      yield* fs
        .makeDirectory(backupRoot, { recursive: true })
        .pipe(Effect.mapError(blocked(`Could not create ${backupRoot}.`)));
      const probe = path.join(backupRoot, `.probe-${process.pid}`);
      yield* fs
        .writeFileString(probe, "ok")
        .pipe(
          Effect.andThen(fs.remove(probe)),
          Effect.mapError(blocked(`${backupRoot} is not writable.`)),
        );

      const databaseBytes = yield* fs.stat(config.dbPath).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.mapError(blocked(`Could not read ${config.dbPath}.`)),
      );
      // Only macOS backups copy the app.
      const appBytes = isMac ? yield* directoryBytes(bundle) : 0;
      const required = Math.ceil(databaseBytes * 1.2) + appBytes + FREE_SPACE_MARGIN_BYTES;
      const available = yield* Effect.tryPromise(() =>
        NodeFSP.statfs(backupRoot, { bigint: true }),
      ).pipe(
        Effect.map((stats) => Number(stats.bavail * stats.bsize)),
        Effect.mapError(blocked(`Could not read free space for ${backupRoot}.`)),
      );
      if (available < required) {
        return yield* new HostDeploymentBlocked({
          reason: `The backup needs ${Math.ceil(required / 1024 ** 3)} GiB free in ${backupRoot}; ${Math.floor(available / 1024 ** 3)} GiB is available. Free space or empty the Trash, then retry.`,
        });
      }
    });

  const FACTS_SQL = [
    "PRAGMA quick_check",
    "SELECT count(*) FROM orchestration_v2_projection_threads",
    "SELECT count(*) FROM projection_projects",
  ];

  // macOS checks out of process with the system sqlite3, so a large database
  // does not stall this server.
  const sqliteCliFacts = (database: string) =>
    run("/usr/bin/sqlite3", ["-readonly", database, `${FACTS_SQL.join("; ")};`], "15 minutes").pipe(
      Effect.mapError(blocked("Could not run sqlite3 to verify the state backup.")),
      Effect.map((result) => {
        const [check, threads, projects] = result.stdout.trim().split("\n");
        return {
          ok: result.code === 0,
          check: check ?? result.stderr.trim(),
          threads: Number(threads),
          projects: Number(projects),
        };
      }),
    );

  // Windows ships no sqlite3, so the check runs in-process while runs are gated.
  const sqliteInProcessFacts = (database: string) =>
    Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
        try {
          const [check, threads, projects] = FACTS_SQL.map(
            (statement) => Object.values(db.prepare(statement).get() ?? {})[0],
          );
          return {
            ok: true,
            check: String(check),
            threads: Number(threads),
            projects: Number(projects),
          };
        } finally {
          db.close();
        }
      },
      catch: blocked("Could not open the state backup to verify it."),
    });

  const sqliteFacts = (database: string) =>
    (isMac ? sqliteCliFacts(database) : sqliteInProcessFacts(database)).pipe(
      Effect.flatMap(({ ok, check, threads, projects }) =>
        ok && check === "ok" && Number.isFinite(threads) && Number.isFinite(projects)
          ? Effect.succeed({ threadCount: threads, projectCount: projects })
          : Effect.fail(
              new HostDeploymentBlocked({
                reason: `The state backup failed its integrity check (${check}).`,
              }),
            ),
      ),
    );

  const backup: HostDeploymentHostShape["backup"] = ({ releaseId, from }) =>
    Effect.gen(function* () {
      const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
      const directory = path.join(backupRoot, `${releaseId}-from-${from.version}-${stamp}`);
      yield* fs
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError(blocked(`Could not create ${directory}.`)));

      // The backup API reads a consistent snapshot through its own connection.
      const databaseCopy = path.join(directory, path.basename(config.dbPath));
      yield* Effect.tryPromise(async () => {
        const source = new NodeSqlite.DatabaseSync(config.dbPath, { readOnly: true });
        try {
          await NodeSqlite.backup(source, databaseCopy);
        } finally {
          source.close();
        }
      }).pipe(Effect.mapError(blocked("Could not take a consistent state backup.")));

      for (const file of [
        config.settingsPath,
        config.keybindingsConfigPath,
        config.environmentIdPath,
      ]) {
        if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) continue;
        yield* fs
          .copyFile(file, path.join(directory, path.basename(file)))
          .pipe(Effect.mapError(blocked(`Could not back up ${file}.`)));
      }

      // A Windows install restores by rerunning the previous release's installer.
      let appBundle: HostDeploymentBackup["appBundle"] = null;
      if (isMac && config.appBundlePath !== undefined) {
        const appCopy = path.join(directory, path.basename(config.appBundlePath));
        const ditto = yield* run(
          "/usr/bin/ditto",
          [config.appBundlePath, appCopy],
          "10 minutes",
        ).pipe(Effect.mapError(blocked("Could not copy the running app.")));
        if (ditto.code !== 0) {
          return yield* new HostDeploymentBlocked({ reason: "Could not copy the running app." });
        }
        // A name alone cannot prove what was copied; read the copy's own version.
        const plist = yield* run("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleShortVersionString",
          path.join(appCopy, "Contents", "Info.plist"),
        ]).pipe(Effect.mapError(blocked("Could not read the copied app's version.")));
        const version = plist.stdout.trim();
        if (version !== from.version) {
          return yield* new HostDeploymentBlocked({
            reason: `The copied app reports ${version || "no version"}, not the running ${from.version}.`,
          });
        }
        appBundle = { path: appCopy, version };
      }

      const facts = yield* sqliteFacts(databaseCopy);
      const databaseBytes = yield* fs.stat(databaseCopy).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.mapError(blocked("Could not read the state backup.")),
      );
      const verifiedAt = DateTime.formatIso(yield* DateTime.now);
      yield* fs
        .writeFileString(
          path.join(directory, BACKUP_MANIFEST),
          encodeBackupManifest({ releaseId, verifiedAt }),
        )
        .pipe(Effect.mapError(blocked("Could not record the backup manifest.")));
      return {
        path: directory,
        databaseBytes,
        threadCount: facts.threadCount,
        projectCount: facts.projectCount,
        appBundle,
        verifiedAt,
      } satisfies HostDeploymentBackup;
    });

  const pruneBackups: HostDeploymentHostShape["pruneBackups"] = (keep) =>
    Effect.gen(function* () {
      const names = yield* fs.readDirectory(backupRoot).pipe(Effect.orElseSucceed(() => []));
      const verified: Array<{ readonly directory: string; readonly verifiedAt: string }> = [];
      for (const name of names) {
        const directory = path.join(backupRoot, name);
        const manifest = yield* fs.readFileString(path.join(directory, BACKUP_MANIFEST)).pipe(
          Effect.map(decodeBackupManifest),
          Effect.orElseSucceed(() => Option.none()),
        );
        // Only backups this service verified; anything else is left alone.
        if (Option.isSome(manifest))
          verified.push({ directory, verifiedAt: manifest.value.verifiedAt });
      }
      verified.sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt));
      if (!isMac) {
        for (const { directory } of verified.slice(keep)) {
          const recycled = yield* run("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${directory.replaceAll("'", "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
          ]).pipe(
            Effect.map((result) => result.code === 0),
            Effect.orElseSucceed(() => false),
          );
          if (!recycled) {
            yield* Effect.logWarning(
              "Could not move an old deployment backup to the Recycle Bin.",
              { directory },
            );
          }
        }
        return;
      }
      const trash = path.join(NodeOS.homedir(), ".Trash");
      for (const { directory } of verified.slice(keep)) {
        const name = path.basename(directory);
        let target = path.join(trash, name);
        if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true))) {
          target = path.join(trash, `${name}-${yield* Clock.currentTimeMillis}`);
        }
        yield* fs.rename(directory, target).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not move an old deployment backup to the Trash.", {
              directory,
              cause,
            }),
          ),
        );
      }
    });

  const liveCounts = Effect.gen(function* () {
    const threads = yield* sql<{ readonly count: number }>`
      SELECT count(*) AS count FROM orchestration_v2_projection_threads
    `;
    const projects = yield* sql<{ readonly count: number }>`
      SELECT count(*) AS count FROM projection_projects
    `;
    return { threadCount: threads[0]?.count ?? 0, projectCount: projects[0]?.count ?? 0 };
  }).pipe(Effect.mapError(blocked("Could not count threads and projects.")));

  const settingsReadable = fs.readFileString(config.settingsPath).pipe(
    Effect.map(parsesAsJson),
    // A missing file is the default settings, which is readable.
    Effect.orElseSucceed(() => true),
  );

  return HostDeploymentHost.of({
    runtimeIdentity,
    approvedArtifact: (request) => approvedArtifact(request, platform),
    preflight,
    backup,
    pruneBackups,
    liveCounts,
    settingsReadable,
  });
});

export const layer = Layer.effect(HostDeploymentHost, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
