import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as NodePath from "@effect/platform-node/NodePath";
import { CommandId, ThreadId, type OrchestrationV2AppThread } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ForkUpdate from "./ForkUpdate.ts";

const threadId = ThreadId.make("update-owner");
const goalId = CommandId.make("update-goal");
const markerPath = "/fixture/runtime/fork-update-paused-goals.json";
const error = () =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      module: "FileSystem",
      method: "readFileString",
      _tag: "NotFound",
      pathOrDescriptor: markerPath,
    }),
  );
const harness = Effect.fn(function* (
  options: {
    unsupported?: boolean;
    markerFailure?: boolean;
    installerFailure?: boolean;
    badFeed?: boolean;
    hold?: Deferred.Deferred<void>;
    files?: Map<string, string>;
    goal?: Record<string, unknown>;
    failResume?: boolean;
  } = {},
) {
  const files = options.files ?? new Map<string, string>();
  let goal = options.goal ?? { id: goalId, status: "active", statusReason: null };
  const commands: Array<string> = [];
  const commandIds: CommandId[] = [];
  const requests: string[] = [];
  const processes: ProcessRunner.ProcessRunInput[] = [];
  let sweep: Effect.Effect<void> = Effect.void;
  const fs = FileSystem.makeNoop({
    readFileString: (path) =>
      Effect.suspend(() =>
        path.endsWith("Info.plist")
          ? Effect.succeed("<key>CFBundleShortVersionString</key><string>0.0.44-nick.5</string>")
          : files.has(path)
            ? Effect.succeed(files.get(path)!)
            : Effect.fail(error()),
      ),
    writeFileString: (path, value) =>
      options.markerFailure && path === markerPath
        ? Effect.fail(error())
        : Effect.sync(() => void files.set(path, value)),
    makeDirectory: () => Effect.void,
    remove: (path) => Effect.sync(() => void files.delete(path)),
  });
  const build = ForkUpdate.ForkUpdate.pipe(
    Effect.provide(
      ForkUpdate.layer.pipe(
        Layer.provide(Layer.mergeAll(NodePath.layer, NodeCrypto.layer, FetchHttpClient.layer)),
      ),
    ),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(FetchHttpClient.Fetch, async (input) => {
      const url = String(input);
      requests.push(url);
      return url.endsWith("fork-update.sh")
        ? new Response("# fake installer")
        : new Response(
            JSON.stringify(
              options.badFeed
                ? { unexpected: true }
                : {
                    version: "0.0.44-nick.6",
                    commit: "a".repeat(40),
                    builtAt: "2026-10-10T00:00:00Z",
                  },
            ),
          );
    }),
    Effect.provideService(HostProcess.Platform, options.unsupported ? "linux" : "darwin"),
    Effect.provideService(
      HostProcess.ExecutablePath,
      "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code",
    ),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(ServerConfig.ServerConfig, {
      baseDir: "/fixture",
      mode: "desktop",
    } as ServerConfig.ServerConfig["Service"]),
    Effect.provideService(Scheduler.Scheduler, {
      register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          sweep = work.pipe(Effect.provideContext(context), Effect.orDie);
        }),
    }),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, {
      getGoalThreads: () =>
        Effect.succeed([{ id: threadId, goal }] as unknown as OrchestrationV2AppThread[]),
      getThread: () =>
        Effect.succeed({
          id: threadId,
          goal,
          deletedAt: null,
          archivedAt: null,
        } as unknown as OrchestrationV2AppThread),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Effect.provideService(Orchestrator.OrchestratorV2, {
      dispatch: (command: OrchestrationV2ServerCommand) =>
        Effect.gen(function* () {
          if (command.type !== "thread.goal.control")
            return yield* Effect.die("Unexpected command");
          commands.push(command.action);
          commandIds.push(command.commandId);
          if (options.failResume && command.action === "resume")
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            });
          if (command.action === "pause") assert.isTrue(files.has(markerPath));
          goal = {
            ...goal,
            status: command.action === "pause" ? "paused" : "active",
            statusReason: command.action === "pause" ? "user" : null,
            lastControlCommandId: command.commandId,
          };
          return { sequence: 1, storedEvents: [] };
        }),
    } as unknown as Orchestrator.OrchestratorV2["Service"]),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.gen(function* () {
          processes.push(input);
          if (options.hold) yield* Deferred.await(options.hold);
          return {
            stdout: "private output is not exposed",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(options.installerFailure ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    } as ProcessRunner.ProcessRunner["Service"]),
  );
  const service = yield* build;
  return {
    service,
    files,
    commands,
    commandIds,
    requests,
    processes,
    sweep: () => sweep,
    goal: () => goal,
    userPause: () => {
      goal = { ...goal, lastControlCommandId: CommandId.make("user-pause") };
    },
  };
});

it.effect("unsupported servers perform no release HTTP or installer work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ unsupported: true });
      assert.isFalse((yield* h.service.status({ refresh: true })).supported);
      assert.strictEqual((yield* h.service.install.pipe(Effect.result))._tag, "Failure");
      assert.lengthOf(h.requests, 0);
      assert.lengthOf(h.processes, 0);
    }),
  ),
);
it.effect("invalid release metadata cannot offer or install an update", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ badFeed: true });
      const status = yield* h.service.status({ refresh: true });
      assert.isFalse(status.updateAvailable);
      assert.isNotNull(status.error);
      assert.strictEqual((yield* h.service.install.pipe(Effect.result))._tag, "Failure");
      assert.lengthOf(h.processes, 0);
    }),
  ),
);
it.effect("saves recovery before pausing and hands off the pinned version once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.status({ refresh: true });
      const result = yield* h.service.install;
      assert.strictEqual(result.pausedGoals, 1);
      assert.deepEqual(h.commands, ["pause"]);
      assert.deepEqual(h.processes[0]?.args.slice(1), [
        "--version",
        "0.0.44-nick.6",
        "--wait-mins",
        "150",
      ]);
      assert.notInclude(result.message, "private");
      yield* h.sweep();
      assert.deepEqual(h.commands, ["pause"]);
      assert.strictEqual((yield* h.service.install.pipe(Effect.result))._tag, "Failure");
      assert.lengthOf(h.processes, 1);
    }),
  ),
);
it.effect("marker failure prevents every pause and installer invocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ markerFailure: true });
      yield* h.service.status({ refresh: true });
      assert.strictEqual((yield* h.service.install.pipe(Effect.result))._tag, "Failure");
      assert.deepEqual(h.commands, []);
      assert.lengthOf(h.processes, 0);
    }),
  ),
);
it.effect("failed installer restores its pauses and removes completed recovery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ installerFailure: true });
      yield* h.service.status({ refresh: true });
      assert.strictEqual((yield* h.service.install.pipe(Effect.result))._tag, "Failure");
      assert.deepEqual(h.commands, ["pause", "resume"]);
      assert.isFalse(h.files.has(markerPath));
    }),
  ),
);
it.effect("reconstruction resumes unchanged pauses and preserves subsequent user controls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* harness();
      yield* first.service.status({ refresh: true });
      yield* first.service.install;
      const second = yield* harness({
        files: first.files,
        goal: { ...first.goal(), updatedAt: "worker progress" },
      });
      yield* second.sweep();
      assert.deepEqual(second.commands, ["resume"]);
      assert.isFalse(second.files.has(markerPath));
      const third = yield* harness();
      yield* third.service.status({ refresh: true });
      yield* third.service.install;
      third.userPause();
      const fourth = yield* harness({ files: third.files, goal: third.goal() });
      yield* fourth.sweep();
      assert.deepEqual(fourth.commands, []);
      assert.isFalse(fourth.files.has(markerPath));
    }),
  ),
);
it.effect("failed startup recovery retains its marker for another sweep", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* harness();
      yield* first.service.status({ refresh: true });
      yield* first.service.install;
      const second = yield* harness({ files: first.files, goal: first.goal(), failResume: true });
      yield* second.sweep();
      yield* second.sweep();
      assert.deepEqual(second.commands, ["resume", "resume"]);
      assert.isTrue(second.files.has(markerPath));
    }),
  ),
);
it.effect("simultaneous installs start one process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const h = yield* harness({ hold });
      yield* h.service.status({ refresh: true });
      const first = yield* h.service.install.pipe(Effect.result, Effect.forkChild);
      const second = yield* h.service.install.pipe(Effect.result, Effect.forkChild);
      yield* Deferred.succeed(hold, undefined);
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.deepEqual(results.map((r) => r._tag).sort(), ["Failure", "Success"]);
      assert.lengthOf(h.processes, 1);
    }),
  ),
);
it.effect("stale handoff resumes goals after the installer wait window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.status({ refresh: true });
      yield* h.service.install;
      yield* TestClock.adjust("166 minutes");
      yield* h.sweep();
      assert.deepEqual(h.commands, ["pause", "resume"], h.files.get(markerPath));
      assert.isNull((yield* h.service.status({})).installingVersion);
    }),
  ),
);

it.effect("a failed install can pause again at the same timestamp without reusing a receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ installerFailure: true });
      yield* h.service.status({ refresh: true });
      yield* h.service.install.pipe(Effect.result);
      yield* h.service.install.pipe(Effect.result);
      assert.deepEqual(h.commands, ["pause", "resume", "pause", "resume"]);
      assert.lengthOf(h.processes, 2);
      assert.notStrictEqual(h.commandIds[0], h.commandIds[2]);
      assert.notStrictEqual(h.commandIds[1], h.commandIds[3]);
    }),
  ),
);

it.effect("corrupt recovery state prevents overwriting pauses or running the installer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness({ files: new Map([[markerPath, "broken json"]]) });
      yield* h.service.status({ refresh: true });
      assert.strictEqual((yield* h.service.install.pipe(Effect.result))._tag, "Failure");
      assert.deepEqual(h.commands, []);
      assert.lengthOf(h.processes, 0);
      assert.strictEqual(h.files.get(markerPath), "broken json");
    }),
  ),
);
