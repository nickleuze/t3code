import {
  TicketError,
  TicketEvent,
  TicketSyncStatus,
  type TicketSetupCheck,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Crypto from "effect/Crypto";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export class TicketSyncService extends Context.Service<
  TicketSyncService,
  {
    readonly setupCheck: Effect.Effect<TicketSetupCheck, TicketError>;
    readonly setLabel: (label: string) => Effect.Effect<TicketSyncStatus, TicketError>;
    readonly status: Effect.Effect<TicketSyncStatus, TicketError>;
    readonly configure: (remote: string) => Effect.Effect<TicketSyncStatus, TicketError>;
    readonly append: (events: readonly TicketEvent[]) => Effect.Effect<void, TicketError>;
    readonly refresh: Effect.Effect<readonly TicketEvent[], TicketError>;
    readonly localEvents: Effect.Effect<readonly TicketEvent[], TicketError>;
    readonly machines: Effect.Effect<Readonly<Record<string, string>>, TicketError>;
    readonly registry: Effect.Effect<Readonly<Record<string, string>>, TicketError>;
    readonly registerProject: (key: string, name: string) => Effect.Effect<void, TicketError>;
    /**
     * Makes `snapshot/` in the backlog clone hold exactly `files` (paths
     * relative to it), then commits and pushes only when something changed.
     */
    readonly writeSnapshot: (
      files: ReadonlyMap<string, string>,
    ) => Effect.Effect<{ readonly committed: boolean }, TicketError>;
    readonly machine: string;
    readonly label: string;
  }
>()("t3/tickets/TicketSyncService") {}

const mapError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isTicketError(cause)
        ? cause
        : new TicketError({ message: "Ticket sync failed. Local events are queued.", cause }),
    ),
  );
const Config = Schema.Struct({
  registryPending: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  branch: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("main"))),
  machine: Schema.String,
  label: Schema.String,
  remote: Schema.NullOr(Schema.String),
  lastPullAt: Schema.NullOr(Schema.String),
  lastPushAt: Schema.NullOr(Schema.String),
});

const isTicketError = Schema.is(TicketError);
const SNAPSHOT_MESSAGE = "Snapshot tickets as Markdown";
const SNAPSHOT_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config));
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Config));
const decodeRegistry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(TicketEvent));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(TicketEvent));
const decodeMachine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, label: Schema.String })),
);

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const label =
    environment._tag === "Some"
      ? (yield* environment.value.getDescriptor).label
      : path.basename(config.baseDir);
  const write = (input: { filePath: string; contents: string }) =>
    writeFileStringAtomically(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const repo = path.join(config.baseDir, "tickets-repo");
  const outbox = path.join(config.baseDir, "tickets-outbox");
  const archive = path.join(config.baseDir, "tickets-sent");
  const configPath = path.join(config.baseDir, "tickets-sync.json");
  const localRegistryPath = path.join(config.baseDir, "tickets-projects.json");
  yield* fs.makeDirectory(outbox, { recursive: true });
  let state: { -readonly [K in keyof typeof Config.Type]: (typeof Config.Type)[K] } = {
    registryPending: false,
    branch: "main",
    machine: yield* crypto.randomUUIDv4(),
    label,
    remote: null as string | null,
    lastPullAt: null as string | null,
    lastPushAt: null as string | null,
  };
  if (yield* fs.exists(configPath))
    state = yield* decodeConfig(yield* fs.readFileString(configPath));
  else yield* write({ filePath: configPath, contents: yield* encodeConfig(state) });
  let lastError: string | null = null;
  const lock = yield* Semaphore.make(1);
  const save = Effect.fn("save")(function* () {
    yield* write({ filePath: configPath, contents: yield* encodeConfig(state) });
  });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const git = (args: readonly string[], cwd = repo) =>
    runner.run({
      command: "git",
      args,
      cwd,
      timeout: "30 seconds",
      maxOutputBytes: 2 * 1024 * 1024,
      env: {
        GIT_AUTHOR_NAME: "T3 Tickets",
        GIT_AUTHOR_EMAIL: "tickets@localhost",
        GIT_COMMITTER_NAME: "T3 Tickets",
        GIT_COMMITTER_EMAIL: "tickets@localhost",
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "",
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS: "",
        SSH_ASKPASS_REQUIRE: "never",
      },
    });
  const hasConflict = Effect.fn("hasConflict")(function* (stderr: string) {
    const markers = yield* git(["diff", "--name-only", "--diff-filter=U"]);
    return (
      Boolean(markers.stdout.trim()) ||
      /\bconflicts?\b/i.test(stderr) ||
      // Git can leave rebase state after a fatal identity/network failure too.
      (!/\bfatal:|identity unknown/i.test(stderr) &&
        ((yield* fs.exists(path.join(repo, ".git/rebase-merge"))) ||
          (yield* fs.exists(path.join(repo, ".git/rebase-apply")))))
    );
  });
  const checked = Effect.fn("checked")(function* (args: readonly string[], cwd = repo) {
    const output = yield* git(args, cwd);
    if (output.code === 0) return output.stdout;
    return yield* new TicketError({
      message:
        args[0] === "pull"
          ? (yield* hasConflict(output.stderr))
            ? "Ticket sync pull/rebase conflict. Resolve the clone conflict manually; local events are kept."
            : "Ticket sync pull failed, will retry. Local events are queued."
          : `Ticket sync ${args[0]} failed. Local events are queued.`,
      cause: output.stderr.slice(-400),
    });
  });
  const registry = Effect.gen(function* () {
    const target =
      state.remote === null ? localRegistryPath : path.join(repo, "registry/projects.json");
    if (!(yield* fs.exists(target))) return {};
    return yield* decodeRegistry(yield* fs.readFileString(target));
  }).pipe(mapError);
  const append = Effect.fn("append")(function* (events: readonly TicketEvent[]) {
    for (const event of events) {
      const target = path.join(outbox, `${event.eventId}.json`);
      const contents = yield* encodeEvent(event);
      if (yield* fs.exists(target)) {
        if ((yield* fs.readFileString(target)) !== contents)
          return yield* new TicketError({
            message: "Queued ticket event identity conflict. Local event was preserved.",
          });
      } else yield* write({ filePath: target, contents });
    }
  }, mapError);
  const readEvents = Effect.gen(function* () {
    const events: TicketEvent[] = [];
    const root = path.join(repo, "tickets");
    if (yield* fs.exists(root))
      for (const ticket of yield* fs.readDirectory(root)) {
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ticket))
          return yield* new TicketError({ message: "Invalid ticket path in sync clone." });
        for (const file of yield* fs.readDirectory(path.join(root, ticket))) {
          if (!/^[0-9A-HJKMNP-TV-Z]{26}-[a-zA-Z0-9-]+\.json$/.test(file))
            return yield* new TicketError({ message: "Invalid event path in sync clone." });
          const event = yield* decodeEvent(yield* fs.readFileString(path.join(root, ticket, file)));
          if (`${event.eventId}.json` !== file || event.ticketId !== ticket)
            return yield* new TicketError({
              message: "Event identity does not match its sync path.",
            });
          events.push(event);
        }
      }
    for (const file of yield* fs.readDirectory(outbox))
      events.push(yield* decodeEvent(yield* fs.readFileString(path.join(outbox, file))));
    return events;
  });
  const sync = Effect.gen(function* () {
    if (state.remote === null) return yield* readEvents;
    if (!(yield* fs.exists(path.join(repo, ".git"))))
      return yield* new TicketError({
        message: "Ticket clone is missing or corrupt. Local events are queued.",
      });
    const conflicts = yield* checked(["diff", "--name-only", "--diff-filter=U"]);
    if (
      conflicts.trim() ||
      (yield* fs.exists(path.join(repo, ".git/rebase-merge"))) ||
      (yield* fs.exists(path.join(repo, ".git/rebase-apply")))
    )
      return yield* new TicketError({
        message:
          "Ticket clone has an unresolved rebase conflict. Local events are kept; resolve it manually.",
      });
    const pending = yield* fs.readDirectory(outbox);
    for (const file of pending) {
      const contents = yield* fs.readFileString(path.join(outbox, file));
      const event = yield* decodeEvent(contents);
      const destination = path.join(repo, "tickets", event.ticketId, file);
      if (yield* fs.exists(destination)) {
        const previous = yield* fs.readFileString(destination);
        if (previous !== contents)
          return yield* new TicketError({
            message: "Ticket event path conflict. Local event is kept; no overwrite was performed.",
          });
      } else yield* write({ filePath: destination, contents });
    }
    yield* checked(["add", "--all", "--", "."]);
    const dirty = yield* checked(["diff", "--cached", "--name-only"]);
    if (dirty.trim()) yield* checked(["commit", "-m", "Append ticket work records"]);
    const remoteRefs = yield* checked(["ls-remote", "--heads", "origin", state.branch]);
    if (remoteRefs.trim()) {
      yield* checked(["pull", "--rebase", "origin", state.branch]);
      state.lastPullAt = yield* now;
    }
    const ahead = remoteRefs.trim()
      ? (yield* checked(["rev-list", "--count", `origin/${state.branch}..HEAD`])).trim()
      : "1";
    if (ahead !== "0") {
      const push = yield* git(["push", "-u", "origin", `HEAD:${state.branch}`]);
      if (push.code !== 0) {
        if (/non-fast-forward|fetch first|rejected/.test(push.stderr)) {
          yield* checked(["pull", "--rebase", "origin", state.branch]);
          yield* checked(["push", "-u", "origin", `HEAD:${state.branch}`]);
        } else
          return yield* new TicketError({
            message: "Ticket push failed. Local events are queued for retry.",
          });
      }
      state.lastPushAt = yield* now;
    }
    // Pull after push imports events written by another machine during our push.
    yield* checked(["pull", "--rebase", "origin", state.branch]);
    state.lastPullAt = yield* now;
    yield* fs.makeDirectory(archive, { recursive: true });
    for (const file of pending) yield* fs.rename(path.join(outbox, file), path.join(archive, file));
    // An archived event is redundant only once its exact bytes are committed.
    // Checking HEAD (rather than the working tree) preserves retry recovery.
    for (const file of yield* fs.readDirectory(archive)) {
      const contents = yield* fs.readFileString(path.join(archive, file));
      const event = yield* decodeEvent(contents);
      const committed = yield* git(["show", `HEAD:tickets/${event.ticketId}/${file}`]);
      if (committed.code === 0 && committed.stdout === contents)
        yield* fs.remove(path.join(archive, file));
    }
    state.registryPending = false;
    yield* save();
    return yield* readEvents;
  });
  const refresh = lock.withPermit(sync).pipe(
    mapError,
    Effect.tap(() =>
      Effect.sync(() => {
        lastError = null;
      }),
    ),
    Effect.tapError((error) =>
      Effect.sync(() => {
        lastError = error.message;
      }),
    ),
  );
  const status = Effect.gen(function* () {
    const queued = yield* Effect.forEach(yield* fs.readDirectory(outbox), (file) =>
      fs.readFileString(path.join(outbox, file)).pipe(Effect.flatMap(decodeEvent)),
    );
    return {
      ...state,
      pendingTicketIds: [...new Set(queued.map((e) => e.ticketId))],
      configured: state.remote !== null,
      pendingEvents: (yield* fs.readDirectory(outbox)).length + (state.registryPending ? 1 : 0),
      lastError,
    };
  }).pipe(mapError);
  const configure = (remote: string) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          if (state.remote !== null && state.remote !== remote)
            return yield* new TicketError({
              message:
                "A ticket remote is already configured. Preserve or move the clone before changing remotes.",
            });
          if (!(yield* fs.exists(path.join(repo, ".git")))) {
            if (yield* fs.exists(repo))
              return yield* new TicketError({
                message: "Ticket clone path already exists. Preserve it before configuring.",
              });
            yield* checked(["clone", "--", remote, repo], config.baseDir);
          }
          const localRegistry = (yield* fs.exists(localRegistryPath))
            ? yield* decodeRegistry(yield* fs.readFileString(localRegistryPath))
            : {};
          const head = yield* git(["rev-parse", "--verify", "HEAD"]);
          if (head.code === 0)
            state.branch = (yield* checked(["symbolic-ref", "--short", "HEAD"])).trim();
          if (head.code !== 0) {
            yield* checked(["checkout", "-b", "main"]);
            yield* write({
              filePath: path.join(repo, "README.md"),
              contents: "# T3 Tickets\n\nAppend-only ticket work records.\n",
            });
            const local = yield* registry;
            yield* write({
              filePath: path.join(repo, "registry/projects.json"),
              contents: yield* encodeJson(local),
            });
          }
          const registryPath = path.join(repo, "registry/projects.json");
          const registryExists = yield* fs.exists(registryPath);
          const remoteRegistry = registryExists
            ? yield* decodeRegistry(yield* fs.readFileString(registryPath))
            : {};
          const mergedRegistry = { ...localRegistry, ...remoteRegistry };
          if (!registryExists || Object.keys(localRegistry).some((key) => !(key in remoteRegistry)))
            yield* write({ filePath: registryPath, contents: yield* encodeJson(mergedRegistry) });
          yield* fs.makeDirectory(path.join(repo, "tickets"), { recursive: true });
          yield* write({
            filePath: path.join(repo, "machines", `${state.machine}.json`),
            contents: yield* encodeJson({ id: state.machine, label: state.label }),
          });
          state.remote = remote;
          yield* save();
        }),
      )
      .pipe(mapError, Effect.andThen(refresh), Effect.andThen(status));
  const registerProject = (key: string, name: string) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const current = yield* registry;
          const target =
            state.remote === null ? localRegistryPath : path.join(repo, "registry/projects.json");
          if (current[key] === name) return;
          yield* write({
            filePath: target,
            contents: yield* encodeJson({ ...current, [key]: name }),
          });
          state.registryPending = true;
          yield* save();
        }),
      )
      .pipe(mapError);
  const writeSnapshot = (files: ReadonlyMap<string, string>) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          if (state.remote === null || !(yield* fs.exists(path.join(repo, ".git"))))
            return yield* new TicketError({
              message: "Ticket sync is not configured; the snapshot needs the backlog clone.",
            });
          if (
            (yield* checked(["diff", "--name-only", "--diff-filter=U"])).trim() ||
            (yield* fs.exists(path.join(repo, ".git/rebase-merge"))) ||
            (yield* fs.exists(path.join(repo, ".git/rebase-apply")))
          )
            return yield* new TicketError({
              message: "Ticket clone has an unresolved rebase conflict; snapshot skipped.",
            });
          const root = path.join(repo, "snapshot");
          for (const [relative, contents] of files) {
            if (!SNAPSHOT_PATH.test(relative))
              return yield* new TicketError({ message: `Invalid snapshot path: ${relative}` });
            const target = path.join(root, ...relative.split("/"));
            if (!(yield* fs.exists(target)) || (yield* fs.readFileString(target)) !== contents)
              yield* write({ filePath: target, contents });
          }
          if (yield* fs.exists(root))
            for (const entry of yield* fs.readDirectory(root, { recursive: true })) {
              const relative = entry.split(path.sep).join("/");
              if (relative.endsWith(".md") && !files.has(relative))
                yield* fs.remove(path.join(root, entry));
            }
          yield* checked(["add", "--all", "--", "snapshot"]);
          if (!(yield* checked(["diff", "--cached", "--name-only", "--", "snapshot"])).trim())
            return { committed: false };
          yield* checked(["commit", "-m", SNAPSHOT_MESSAGE]);
          const push = git(["push", "-u", "origin", `HEAD:${state.branch}`]);
          let result = yield* push;
          if (result.code !== 0) {
            const pull = yield* git(["pull", "--rebase", "origin", state.branch]);
            result = pull.code === 0 ? yield* push : pull;
          }
          if (result.code !== 0) {
            // Drop only our own derived snapshot commit so event sync never
            // inherits a snapshot conflict; the next run regenerates it.
            yield* git(["rebase", "--abort"]);
            if ((yield* git(["log", "-1", "--format=%s"])).stdout.trim() === SNAPSHOT_MESSAGE)
              yield* checked(["reset", "--keep", "HEAD~1"]);
            return yield* new TicketError({
              message: "Ticket snapshot push failed; it will retry.",
              cause: result.stderr.slice(-400),
            });
          }
          state.lastPushAt = yield* now;
          yield* save();
          return { committed: true };
        }),
      )
      .pipe(mapError);
  const setLabel = (label: string) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          state.label = label;
          yield* save();
          if (state.remote !== null) {
            yield* write({
              filePath: path.join(repo, "machines", `${state.machine}.json`),
              contents: yield* encodeJson({ id: state.machine, label }),
            });
            state.registryPending = true;
            yield* save();
          }
          return yield* status;
        }),
      )
      .pipe(mapError);
  const setupCheck = lock
    .withPermit(
      Effect.gen(function* () {
        const messages: string[] = [];
        const clonePresent =
          (yield* fs.exists(path.join(repo, ".git"))) &&
          (yield* git(["rev-parse", "--git-dir"])).code === 0;
        if (!clonePresent) messages.push("Clone missing or corrupt.");
        const remote =
          state.remote === null
            ? null
            : yield* git(["ls-remote", "--", state.remote], config.baseDir);
        const remoteReachable = remote?.code === 0;
        const authFailed =
          remote !== null &&
          /authentication|permission denied|could not read Username|access denied|publickey|not authorized/i.test(
            remote.stderr,
          );
        // A failed network probe cannot establish authentication either way.
        const authOk = remoteReachable ? true : authFailed ? false : null;
        if (!remoteReachable)
          messages.push(
            authFailed
              ? "Remote authentication failed."
              : "Remote unavailable or not configured; authentication could not be checked.",
          );
        const registryResult = yield* Effect.result(
          Effect.gen(function* () {
            const target =
              state.remote === null ? localRegistryPath : path.join(repo, "registry/projects.json");
            if (!(yield* fs.exists(target))) return false;
            yield* decodeRegistry(yield* fs.readFileString(target));
            return true;
          }),
        );
        const registryParsed = registryResult._tag === "Success" && registryResult.success;
        if (!registryParsed) messages.push("Project registry missing or invalid.");
        return { clonePresent, remoteReachable, authOk, registryParsed, messages };
      }),
    )
    .pipe(mapError);
  const machines = Effect.gen(function* () {
    const labels: Record<string, string> = { [state.machine]: state.label };
    const root = path.join(repo, "machines");
    if (yield* fs.exists(root))
      for (const file of yield* fs.readDirectory(root)) {
        const entry = yield* decodeMachine(yield* fs.readFileString(path.join(root, file)));
        labels[entry.id] = entry.label;
      }
    return labels;
  }).pipe(mapError);
  return TicketSyncService.of({
    setupCheck,
    setLabel,
    status,
    configure,
    append,
    refresh,
    localEvents: readEvents.pipe(mapError),
    machines,
    registry,
    registerProject,
    writeSnapshot,
    machine: state.machine,
    label: state.label,
  });
});
export const layer = Layer.effect(TicketSyncService, make);
