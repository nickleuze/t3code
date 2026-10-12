import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { TicketId, type TicketEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as Processes from "../processRunner.ts";
import * as Sync from "./TicketSyncService.ts";
import { projectTicket, ticketIds } from "./TicketRecord.ts";

const layer = Processes.layer.pipe(Layer.provideMerge(NodeServices.layer));
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* Processes.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "tickets-sync-test-" });
  // Reproduce CI: neither fixtures nor the service can borrow a host git identity.
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
      const keys = [
        "HOME",
        "EMAIL",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_COUNT",
        `GIT_CONFIG_KEY_${count}`,
        `GIT_CONFIG_VALUE_${count}`,
        ...Object.keys(process.env).filter((key) => /^GIT_(AUTHOR|COMMITTER)_/.test(key)),
      ];
      const previous = keys.map((key) => [key, process.env[key]] as const);
      for (const key of keys) delete process.env[key];
      process.env.HOME = root;
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      // macOS git can infer identity from the OS account; the runner cannot.
      process.env.GIT_CONFIG_COUNT = String(count + 1);
      process.env[`GIT_CONFIG_KEY_${count}`] = "user.useConfigOnly";
      process.env[`GIT_CONFIG_VALUE_${count}`] = "true";
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );
  const identity = yield* runner.run({
    command: "git",
    cwd: root,
    args: ["config", "--show-origin", "--get", "user.name"],
  });
  assert.equal(identity.code, 1, identity.stdout);
  const remote = path.join(root, "remote.git");
  const git = (cwd: string, args: readonly string[]) =>
    runner.run({ command: "git", cwd, args }).pipe(
      Effect.tap((output) => Effect.sync(() => assert.equal(output.code, 0, output.stderr))),
      Effect.map((output) => output.stdout),
    );
  yield* git(root, ["init", "--bare", "--initial-branch=main", remote]);
  const aHome = path.join(root, "A");
  const bHome = path.join(root, "B");
  const a = yield* Sync.make.pipe(Effect.provide(ServerConfig.layerTest(root, aHome)));
  const b = yield* Sync.make.pipe(Effect.provide(ServerConfig.layerTest(root, bHome)));
  yield* a.configure(remote);
  yield* b.configure(remote);
  const ids = ticketIds();
  const id = TicketId.make(ids(1_000));
  const created: TicketEvent = {
    ticketId: id,
    eventId: `${ids(1_001)}-${a.machine}`,
    at: "1970-01-01T00:00:01.001Z",
    by: { actor: "user", machine: a.machine },
    type: "created",
    title: "Shared",
    body: "Original",
    projectKey: null,
    source: "web",
    originThread: null,
  };
  return { fs, path, root, remote, aHome, bHome, a, b, git, ids, id, created };
});

it.effect(
  "two machines retain concurrent writes to one ticket and converge deterministically",
  () =>
    Effect.gen(function* () {
      const { a, b, ids, created } = yield* setup;
      yield* a.append([created]);
      yield* a.refresh;
      yield* b.refresh;
      const fromA: TicketEvent = {
        ...created,
        eventId: `${ids(1_002)}-${a.machine}`,
        type: "fields",
        title: "From A",
      };
      const fromB: TicketEvent = {
        ...created,
        eventId: `${ids(1_003)}-${b.machine}`,
        by: { actor: "agent", machine: b.machine },
        type: "fields",
        title: undefined,
        body: "From B",
      };
      yield* a.append([fromA]);
      yield* b.append([fromB]);
      yield* a.refresh;
      yield* b.refresh;
      const aEvents = yield* a.refresh;
      const bEvents = yield* b.refresh;
      assert.deepStrictEqual(projectTicket(aEvents), projectTicket(bEvents));
      assert.equal(projectTicket(aEvents)!.counts.events, 3);
      assert.equal(projectTicket(aEvents)!.ticket.title, "From A");
      assert.equal(projectTicket(aEvents)!.ticket.body, "From B");
      assert.equal((yield* a.status).pendingEvents, 0);
      assert.equal((yield* b.status).pendingEvents, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("push failure is surfaced, queued across restart and succeeds on retry", () =>
  Effect.gen(function* () {
    const { fs, path, root, remote, aHome, a, created } = yield* setup;
    yield* fs.writeFileString(path.join(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n");
    yield* fs.chmod(path.join(remote, "hooks/pre-receive"), 0o755);
    yield* a.append([created]);
    yield* a.refresh.pipe(Effect.flip);
    assert.equal((yield* a.status).pendingEvents, 1);
    assert.ok((yield* a.status).lastError?.includes("push failed"));
    const restarted = yield* Sync.make.pipe(Effect.provide(ServerConfig.layerTest(root, aHome)));
    assert.equal(restarted.machine, a.machine);
    assert.equal((yield* restarted.status).pendingEvents, 1);
    yield* fs.writeFileString(path.join(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 0\n");
    const events = yield* restarted.refresh;
    assert.equal(events.length, 1);
    assert.equal((yield* restarted.status).pendingEvents, 0);
    assert.equal((yield* restarted.status).lastError, null);
  }).pipe(Effect.provide(layer)),
);

it.effect("pull with unrelated remote changes rebases local queued events cleanly", () =>
  Effect.gen(function* () {
    const { fs, path, aHome, a, b, git, created } = yield* setup;
    yield* b.registerProject("imr", "IMR");
    yield* b.refresh;
    yield* a.append([created]);
    const events = yield* a.refresh;
    assert.equal(events.length, 1);
    assert.equal((yield* a.registry).imr, "IMR");
    assert.equal(
      (yield* git(path.join(aHome, "tickets-repo"), ["status", "--porcelain"])).trim(),
      "",
    );
    assert.equal(
      (yield* git(path.join(aHome, "tickets-repo"), [
        "log",
        "-1",
        "--format=%an <%ae>|%cn <%ce>",
      ])).trim(),
      "T3 Tickets <tickets@localhost>|T3 Tickets <tickets@localhost>",
    );
    assert.ok(yield* fs.exists(path.join(aHome, "tickets-repo/registry/projects.json")));
  }).pipe(Effect.provide(layer)),
);

it.effect("same-path rebase conflict is surfaced and local history is preserved", () =>
  Effect.gen(function* () {
    const { fs, path, aHome, bHome, a, b, git, created } = yield* setup;
    yield* a.append([created]);
    yield* a.refresh;
    yield* b.refresh;
    const file = `tickets/${created.ticketId}/${created.eventId}.json`;
    const aRepo = path.join(aHome, "tickets-repo");
    const bRepo = path.join(bHome, "tickets-repo");
    // Deliberately corrupt the append-only invariant to prove git never overwrites it.
    yield* fs.writeFileString(path.join(aRepo, file), "remote conflicting contents\n");
    yield* git(aRepo, ["add", "--", file]);
    yield* git(aRepo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "Remote conflict",
    ]);
    yield* git(aRepo, ["push", "origin", "HEAD:main"]);
    yield* fs.writeFileString(path.join(bRepo, file), "local conflicting contents\n");
    yield* git(bRepo, ["add", "--", file]);
    yield* git(bRepo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "Local conflict",
    ]);
    const localHead = (yield* git(bRepo, ["rev-parse", "HEAD"])).trim();
    const error = yield* b.refresh.pipe(Effect.flip);
    assert.equal(typeof error.cause, "string");
    assert.isAtMost((error.cause as string).length, 400);
    assert.include(error.cause as string, "conflict");
    assert.ok((yield* b.status).lastError?.includes("conflict"));
    assert.equal(
      yield* git(bRepo, ["show", `${localHead}:${file}`]),
      "local conflicting contents\n",
    );
    assert.ok((yield* git(bRepo, ["diff", "--name-only", "--diff-filter=U"])).includes(file));
    yield* b.refresh.pipe(Effect.flip);
    assert.ok((yield* b.status).lastError?.includes("unresolved"));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "missing clone is surfaced with queued events kept, then rebuilds from the same local remote",
  () =>
    Effect.gen(function* () {
      const { fs, path, aHome, remote, a, created } = yield* setup;
      yield* a.append([created]);
      yield* a.refresh;
      yield* fs.rename(path.join(aHome, "tickets-repo"), path.join(aHome, "preserved-clone"));
      yield* a.refresh.pipe(Effect.flip);
      assert.ok((yield* a.status).lastError?.includes("missing or corrupt"));
      assert.isFalse((yield* a.setupCheck).clonePresent);
      yield* a.configure(remote);
      assert.equal((yield* a.refresh).length, 1);
      assert.equal((yield* a.status).lastError, null);
    }).pipe(Effect.provide(layer)),
);

it.effect("configuring an existing repo keeps project names registered before configuration", () =>
  Effect.gen(function* () {
    const { fs, path, root, remote, a } = yield* setup;
    const home = path.join(root, "offline-first");
    const offline = yield* Sync.make.pipe(Effect.provide(ServerConfig.layerTest(root, home)));
    yield* offline.registerProject("lighting", "Lighting Director");
    yield* offline.configure(remote);
    assert.equal((yield* offline.registry).lighting, "Lighting Director");
    assert.equal((yield* a.refresh).length, 0);
    assert.equal((yield* a.registry).lighting, "Lighting Director");
    assert.ok(yield* fs.exists(path.join(home, "tickets-repo/registry/projects.json")));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "setup check verifies local clone, remote/auth and registry, and detects corruption",
  () =>
    Effect.gen(function* () {
      const { a, fs, path, aHome, remote } = yield* setup;
      assert.deepStrictEqual(yield* a.setupCheck, {
        clonePresent: true,
        remoteReachable: true,
        authOk: true,
        registryParsed: true,
        messages: [],
      });
      yield* a.setLabel("Mac mini");
      assert.equal((yield* a.status).label, "Mac mini");
      yield* fs.writeFileString(path.join(aHome, "tickets-repo/registry/projects.json"), "invalid");
      assert.isFalse((yield* a.setupCheck).registryParsed);
      yield* fs.rename(remote, `${remote}-offline`);
      const offline = yield* a.setupCheck;
      assert.isFalse(offline.remoteReachable);
      assert.isNull(offline.authOk);
    }).pipe(Effect.provide(layer)),
);
it.effect("sent archive prunes exact events at HEAD and retains events missing from HEAD", () =>
  Effect.gen(function* () {
    const { a, fs, path, aHome, created, ids } = yield* setup;
    yield* a.append([created]);
    yield* a.refresh;
    const archive = path.join(aHome, "tickets-sent");
    assert.deepStrictEqual(yield* fs.readDirectory(archive), []);
    const missing = { ...created, eventId: `${ids(2000)}-${a.machine}` };
    yield* fs.writeFileString(
      path.join(archive, `${missing.eventId}.json`),
      JSON.stringify(missing),
    );
    yield* a.refresh;
    assert.deepStrictEqual(yield* fs.readDirectory(archive), [`${missing.eventId}.json`]);
  }).pipe(Effect.provide(layer)),
);
it.effect.each([
  { failure: "network", stderr: "Could not resolve host", rebaseStarted: false },
  {
    failure: "identity",
    stderr: "Committer identity unknown\nfatal: unable to auto-detect email address",
    rebaseStarted: true,
  },
])("pull $failure failure is retryable rather than a conflict", ({ stderr, rebaseStarted }) =>
  Effect.gen(function* () {
    const { root, aHome, remote, fs, path } = yield* setup;
    const runner = yield* Processes.ProcessRunner;
    const interrupted = yield* Sync.make.pipe(
      Effect.provide(ServerConfig.layerTest(root, aHome)),
      Effect.provideService(Processes.ProcessRunner, {
        ...runner,
        run: (input) =>
          input.args?.[0] === "pull"
            ? Effect.succeed({
                code: 1,
                stdout: "",
                stderr: `${"x".repeat(450)}\n${stderr}`,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }).pipe(
                Effect.tap(() =>
                  rebaseStarted
                    ? fs.makeDirectory(path.join(aHome, "tickets-repo/.git/rebase-merge"))
                    : Effect.void,
                ),
              )
            : runner.run(input),
      }),
    );
    const error = yield* interrupted.refresh.pipe(Effect.flip);
    assert.include(error.message, "pull failed, will retry");
    assert.notInclude(error.message, "conflict");
    assert.equal(error.cause, `${"x".repeat(450)}\n${stderr}`.slice(-400));
    assert.equal((yield* interrupted.status).lastError, error.message);
    assert.ok(yield* fs.exists(path.join(remote, "HEAD")));
  }).pipe(Effect.provide(layer)),
);
