import { TicketError, TicketEvent, TicketSyncStatus } from "@t3tools/contracts";
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
    readonly status: Effect.Effect<TicketSyncStatus, TicketError>;
    readonly configure: (remote: string) => Effect.Effect<TicketSyncStatus, TicketError>;
    readonly append: (events: readonly TicketEvent[]) => Effect.Effect<void, TicketError>;
    readonly refresh: Effect.Effect<readonly TicketEvent[], TicketError>;
    readonly localEvents: Effect.Effect<readonly TicketEvent[], TicketError>;
    readonly machines: Effect.Effect<Readonly<Record<string, string>>, TicketError>;
    readonly registry: Effect.Effect<Readonly<Record<string, string>>, TicketError>;
    readonly registerProject: (key: string, name: string) => Effect.Effect<void, TicketError>;
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
    machine: yield* crypto.randomUUIDv4,
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
  const save = () =>
    Effect.gen(function* () {
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
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "",
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS: "",
        SSH_ASKPASS_REQUIRE: "never",
      },
    });
  const checked = (args: readonly string[], cwd = repo) =>
    git(args, cwd).pipe(
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.succeed(output.stdout)
          : Effect.fail(
              new TicketError({
                message:
                  args[0] === "pull"
                    ? "Ticket sync pull/rebase failed. Resolve the clone conflict manually; local events are kept."
                    : `Ticket sync ${args[0]} failed. Local events are queued.`,
              }),
            ),
      ),
    );
  const registry = Effect.gen(function* () {
    const target =
      state.remote === null ? localRegistryPath : path.join(repo, "registry/projects.json");
    if (!(yield* fs.exists(target))) return {};
    return yield* decodeRegistry(yield* fs.readFileString(target));
  }).pipe(mapError);
  const append = (events: readonly TicketEvent[]) =>
    Effect.gen(function* () {
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
    }).pipe(mapError);
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
    if (dirty.trim())
      yield* checked([
        "-c",
        "user.name=T3 Tickets",
        "-c",
        "user.email=tickets@localhost",
        "commit",
        "-m",
        "Append ticket work records",
      ]);
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
    return {
      ...state,
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
          const remoteRegistry = (yield* fs.exists(registryPath))
            ? yield* decodeRegistry(yield* fs.readFileString(registryPath))
            : {};
          const mergedRegistry = { ...localRegistry, ...remoteRegistry };
          if (Object.keys(localRegistry).some((key) => !(key in remoteRegistry)))
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
    status,
    configure,
    append,
    refresh,
    localEvents: readEvents.pipe(mapError),
    machines,
    registry,
    registerProject,
    machine: state.machine,
    label: state.label,
  });
});
export const layer = Layer.effect(TicketSyncService, make);
