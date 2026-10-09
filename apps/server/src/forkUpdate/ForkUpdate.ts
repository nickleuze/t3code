/**
 * Fork-only: finds and installs new GitHub releases of the fork.
 *
 * The fork's builds are signed with a self-signed certificate, which
 * Electron's updater does not accept. Instead each release publishes `fork-update.sh`, the same installer
 * `fork/update.sh` that machines run by hand: it verifies the download, then a
 * launchd job waits for running turns, swaps the app, and relaunches it. This
 * service checks the release feed, pauses live goals so the swap is not held
 * up by loops, runs that installer, and resumes the goals after the restart.
 *
 * @module ForkUpdate
 */
import {
  CommandId,
  ForkUpdateError,
  type ForkUpdateInstallResult,
  ForkUpdateRelease,
  type ForkUpdateStatus,
  type ForkUpdateStatusInput,
  ThreadId,
} from "@t3tools/contracts";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

const DEFAULT_REPOSITORY = "nickleuze/t3code";
/** The installer swaps this exact bundle. */
const INSTALLED_APP = "/Applications/T3 Code (Alpha).app";
const CHECK_INTERVAL = Duration.minutes(10);
/** Goal iterations can run two hours, so the installer waits past that for turns to end. */
const INSTALL_WAIT_MINS = 150;
const PAUSE_MARKER_FILE = "fork-update-paused-goals.json";
/** An install that never restarted the app gave up; its paused goals resume after this. */
const STALE_PAUSE = Duration.minutes(INSTALL_WAIT_MINS + 15);

/** The run number of a fork build version such as `0.0.44-nick.12`. */
export function forkBuildNumber(version: string): number | null {
  const match = /-nick\.(\d+)$/.exec(version);
  return match ? Number(match[1]) : null;
}

export function isNewerForkVersion(latest: string, installed: string): boolean {
  const latestBuild = forkBuildNumber(latest);
  const installedBuild = forkBuildNumber(installed);
  return latestBuild !== null && installedBuild !== null && latestBuild > installedBuild;
}

/** `CFBundleShortVersionString` from an Info.plist in XML form. */
export function bundleShortVersion(infoPlist: string): string | null {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
    infoPlist,
  );
  return match?.[1]?.trim() || null;
}

const PauseMarker = Schema.Struct({
  version: Schema.String,
  pausedAt: Schema.String,
  goals: Schema.Array(Schema.Struct({ threadId: ThreadId, goalId: CommandId })),
});
type PauseMarker = typeof PauseMarker.Type;
const PauseMarkerJson = Schema.fromJsonString(PauseMarker);
const encodePauseMarker = Schema.encodeEffect(PauseMarkerJson);

export class ForkUpdate extends Context.Service<
  ForkUpdate,
  {
    readonly status: (input: ForkUpdateStatusInput) => Effect.Effect<ForkUpdateStatus>;
    readonly install: Effect.Effect<ForkUpdateInstallResult, ForkUpdateError>;
  }
>()("t3/forkUpdate/ForkUpdate") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const platform = yield* HostProcessPlatform;
  const executablePath = yield* HostProcessExecutablePath;
  const environment = yield* HostProcessEnvironment;
  const repository = environment.T3CODE_FORK_UPDATE_REPOSITORY?.trim() || DEFAULT_REPOSITORY;
  const runtimeDir = path.join(config.baseDir, "runtime");
  const markerPath = path.join(runtimeDir, PAUSE_MARKER_FILE);

  // The desktop runs this server as its own Electron binary, so the executable
  // sits inside the installed app bundle.
  const bundleIndex = executablePath.indexOf(".app/Contents/MacOS/");
  const bundlePath =
    platform === "darwin" && config.mode === "desktop" && bundleIndex >= 0
      ? executablePath.slice(0, bundleIndex + ".app".length)
      : null;
  const installedVersion =
    bundlePath === null
      ? null
      : yield* fs.readFileString(path.join(bundlePath, "Contents", "Info.plist")).pipe(
          Effect.map(bundleShortVersion),
          Effect.orElseSucceed(() => null),
        );
  const supported =
    bundlePath === INSTALLED_APP &&
    installedVersion !== null &&
    forkBuildNumber(installedVersion) !== null;

  const statusRef = yield* Ref.make<ForkUpdateStatus>({
    supported,
    installedVersion,
    latest: null,
    updateAvailable: false,
    checkedAt: null,
    installingVersion: null,
    error: null,
  });
  const lastCheckMs = yield* Ref.make(0);
  const startupHandled = yield* Ref.make(false);

  const releaseUrl = (version: string, asset: string) =>
    `https://github.com/${repository}/releases/download/fork-v${version}/${asset}`;

  const fetchLatest = httpClient
    .execute(
      HttpClientRequest.get(
        `https://github.com/${repository}/releases/latest/download/fork-release.json`,
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(ForkUpdateRelease)),
      Effect.timeout(Duration.seconds(30)),
    );

  const check = Effect.gen(function* () {
    yield* Ref.set(lastCheckMs, DateTime.toEpochMillis(yield* DateTime.now));
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const result = yield* fetchLatest.pipe(Effect.result);
    yield* Ref.update(statusRef, (current) =>
      result._tag === "Success"
        ? {
            ...current,
            latest: result.success,
            updateAvailable:
              installedVersion !== null &&
              isNewerForkVersion(result.success.version, installedVersion),
            checkedAt,
            error: null,
          }
        : { ...current, checkedAt, error: "Could not reach the fork's release feed." },
    );
  });

  const readMarker = fs
    .readFileString(markerPath)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PauseMarkerJson)), Effect.option);

  /** Resumes the goals this service paused, unless the user changed them since. */
  const resumePausedGoals = (marker: PauseMarker) =>
    Effect.gen(function* () {
      for (const { threadId, goalId } of marker.goals) {
        const thread = yield* projections.getThread(threadId).pipe(Effect.option);
        const goal = Option.isSome(thread) ? thread.value.goal : null;
        if (goal?.id !== goalId || goal.status !== "paused" || goal.statusReason !== "user") {
          continue;
        }
        yield* orchestrator
          .dispatch({
            type: "thread.goal.control",
            commandId: CommandId.make(`fork-update:resume:${threadId}:${marker.pausedAt}`),
            threadId,
            goalId,
            action: "resume",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("fork-update.resume-goal-failed", { threadId, cause }),
            ),
          );
      }
      yield* fs.remove(markerPath).pipe(Effect.ignore);
    });

  const pauseLiveGoals = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const paused: Array<{ threadId: ThreadId; goalId: CommandId }> = [];
    for (const thread of yield* projections.getGoalThreads().pipe(Effect.orElseSucceed(() => []))) {
      const goal = thread.goal;
      if (goal == null || (goal.status !== "active" && goal.status !== "usageLimited")) continue;
      const result = yield* orchestrator
        .dispatch({
          type: "thread.goal.control",
          commandId: CommandId.make(`fork-update:pause:${thread.id}:${now}`),
          threadId: thread.id,
          goalId: goal.id,
          action: "pause",
        })
        .pipe(Effect.result);
      if (result._tag === "Success") paused.push({ threadId: thread.id, goalId: goal.id });
    }
    return { pausedAt: now, goals: paused };
  });

  const install = Effect.gen(function* () {
    const current = yield* Ref.get(statusRef);
    if (!current.supported) {
      return yield* new ForkUpdateError({
        reason: "This machine is not running an installed fork build.",
      });
    }
    if (current.installingVersion !== null) {
      return yield* new ForkUpdateError({
        reason: `Fork ${current.installingVersion} is already installing.`,
      });
    }
    if (current.latest === null || !current.updateAvailable) {
      return yield* new ForkUpdateError({ reason: "No newer fork release is available." });
    }
    const version = current.latest.version;
    yield* fs.makeDirectory(runtimeDir, { recursive: true }).pipe(Effect.ignore);
    const scriptPath = path.join(runtimeDir, "fork-update.sh");
    const script = yield* httpClient
      .execute(HttpClientRequest.get(releaseUrl(version, "fork-update.sh")))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(
          () => new ForkUpdateError({ reason: `Could not download the installer for ${version}.` }),
        ),
      );
    yield* fs
      .writeFileString(scriptPath, script)
      .pipe(
        Effect.mapError(() => new ForkUpdateError({ reason: "Could not save the installer." })),
      );

    // Paused goals finish their running iteration but start no new one, so
    // the installer's wait for idle turns can end.
    const pause = yield* pauseLiveGoals;
    const marker: PauseMarker = { version, ...pause };
    yield* encodePauseMarker(marker).pipe(
      Effect.flatMap((text) => fs.writeFileString(markerPath, text)),
      Effect.ignore,
    );

    const output = yield* processRunner
      .run({
        command: "/bin/bash",
        args: [scriptPath, "--version", version, "--wait-mins", String(INSTALL_WAIT_MINS)],
        timeout: "15 minutes",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    const lastLine = Option.match(output, {
      onNone: () => "",
      onSome: ({ stdout, stderr }) =>
        `${stdout}\n${stderr}`
          .split("\n")
          .map((line) => line.trim())
          .findLast((line) => line.length > 0 && !line.startsWith("#")) ?? "",
    });
    if (Option.isNone(output) || output.value.timedOut || Number(output.value.code) !== 0) {
      yield* resumePausedGoals(marker);
      return yield* new ForkUpdateError({
        reason: lastLine || `The installer for ${version} did not start.`,
      });
    }
    yield* Ref.update(statusRef, (status) => ({ ...status, installingVersion: version }));
    return { version, pausedGoals: pause.goals.length, message: lastLine };
  });

  const sweep = Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const marker = yield* readMarker;
    // A marker left from before this process started means the app restarted,
    // normally onto the new version: the goals it paused can run again.
    if (!(yield* Ref.getAndSet(startupHandled, true)) && Option.isSome(marker)) {
      return yield* resumePausedGoals(marker.value);
    }
    if (
      Option.isSome(marker) &&
      (yield* Ref.get(statusRef)).installingVersion !== null &&
      nowMs - Date.parse(marker.value.pausedAt) > Duration.toMillis(STALE_PAUSE)
    ) {
      yield* Ref.update(statusRef, (status) => ({ ...status, installingVersion: null }));
      yield* resumePausedGoals(marker.value);
    }
    if (supported && nowMs - (yield* Ref.get(lastCheckMs)) > Duration.toMillis(CHECK_INTERVAL)) {
      yield* check;
    }
  });

  const scheduler = yield* Scheduler.Scheduler;
  yield* scheduler.register("fork-update", sweep);

  return ForkUpdate.of({
    status: (input) =>
      Effect.gen(function* () {
        if (input.refresh === true && supported) yield* check;
        return yield* Ref.get(statusRef);
      }),
    install: install.pipe(Effect.withSpan("ForkUpdate.install")),
  });
});

export const layer = Layer.effect(ForkUpdate, make).pipe(Layer.provide(Scheduler.layer));
