import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, TicketId, type Ticket, type TicketEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Processes from "../processRunner.ts";
import * as Snapshot from "./TicketSnapshot.ts";
import * as Sync from "./TicketSyncService.ts";
import * as Tickets from "./TicketService.ts";

const ULID = TicketId.make("01JQ4K7QZ8R3PB5W1N0D4K7QXM");
const by = { actor: "agent" as const, machine: "mac" };
const ticket: Ticket = {
  id: ULID,
  readableId: "lighting-director-4K7QXM",
  projectKey: "lighting-director",
  projectId: null,
  title: "Fix rim light: falloff",
  body: "Falloff is linear.\n",
  status: "in_review",
  statusSetAt: "2026-10-12T10:00:00.000Z",
  sortKey: 0,
  createdBy: "user",
  creationSource: "web",
  originThreadId: null,
  githubIssue: null,
  links: [],
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
  deletedAt: null,
};
const events: TicketEvent[] = [
  {
    eventId: "01JQ4K7QZ8R3PB5W1N0D4K7QX0-mac",
    ticketId: ULID,
    at: "2026-10-11T10:00:00.000Z",
    by,
    type: "created",
    title: ticket.title,
    body: ticket.body,
    projectKey: "lighting-director",
    source: "web",
    originThread: null,
  },
  {
    eventId: "01JQ4K7QZ8R3PB5W1N0D4K7QX2-mac",
    ticketId: ULID,
    at: "2026-10-12T09:00:00.000Z",
    by,
    type: "entry",
    kind: "result",
    text: "falloff now inverse-square\nscreenshot attached",
    next: "Nick checks the render",
  },
  {
    eventId: "01JQ4K7QZ8R3PB5W1N0D4K7QX1-mac",
    ticketId: ULID,
    at: "2026-10-11T12:00:00.000Z",
    by,
    type: "entry",
    kind: "decision",
    text: "Use inverse-square",
  },
  {
    eventId: "01JQ4K7QZ8R3PB5W1N0D4K7QX3-mac",
    ticketId: ULID,
    at: "2026-10-12T09:30:00.000Z",
    by,
    type: "link",
    kind: "pr",
    ref: "https://github.com/nickleuze/lighting-director/pull/31",
    role: "work",
    machine: "mac",
    title: "Inverse-square falloff",
  },
];

it("renders frontmatter, description, ordered entries and links", () => {
  assert.equal(
    Snapshot.renderTicket({ ticket, events, area: "photography" }),
    [
      "---",
      "id: lighting-director-4K7QXM",
      "ulid: 01JQ4K7QZ8R3PB5W1N0D4K7QXM",
      "area: photography",
      "project: lighting-director",
      "status: in_review",
      'title: "Fix rim light: falloff"',
      "---",
      "",
      "# Fix rim light: falloff",
      "",
      "Falloff is linear.",
      "",
      "## Entries",
      "",
      "- 2026-10-11 decision: Use inverse-square",
      "- 2026-10-12 result: falloff now inverse-square",
      "  screenshot attached",
      "  Next: Nick checks the render",
      "",
      "## Links",
      "",
      "- pr: https://github.com/nickleuze/lighting-director/pull/31: Inverse-square falloff (work)",
      "",
    ].join("\n"),
  );
});

it("places Ideas in _inbox, drops deleted tickets and ignores input order", () => {
  const idea = {
    ...ticket,
    id: TicketId.make("01JQ4K7QZ8R3PB5W1N0D4K7QYY"),
    readableId: null,
    projectKey: null,
  };
  const gone = {
    ...ticket,
    id: TicketId.make("01JQ4K7QZ8R3PB5W1N0D4K7QZZ"),
    deletedAt: ticket.updatedAt,
  };
  const forward = Snapshot.renderSnapshot([
    { ticket, events },
    { ticket: idea, events: [] },
    { ticket: gone, events: [] },
  ]);
  assert.deepStrictEqual(
    [...forward.keys()],
    ["_inbox/01JQ4K7QZ8R3PB5W1N0D4K7QYY.md", "lighting-director/4K7QXM.md"],
  );
  const inbox = forward.get("_inbox/01JQ4K7QZ8R3PB5W1N0D4K7QYY.md")!;
  assert.notInclude(inbox, "\nid:");
  assert.notInclude(inbox, "\nproject:");
  const backward = Snapshot.renderSnapshot([
    { ticket: idea, events: [] },
    { ticket, events: events.toReversed() },
  ]);
  assert.deepStrictEqual([...backward], [...forward]);
});

const gitSetup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* Processes.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "tickets-snapshot-test-" });
  // No host git identity: the sync service sets its own.
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
      const keys = [
        "HOME",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_COUNT",
        `GIT_CONFIG_KEY_${count}`,
        `GIT_CONFIG_VALUE_${count}`,
      ];
      const previous = keys.map((key) => [key, process.env[key]] as const);
      process.env.HOME = root;
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
      process.env.GIT_CONFIG_NOSYSTEM = "1";
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
  const remote = path.join(root, "remote.git");
  const git = (args: readonly string[]) =>
    runner.run({ command: "git", cwd: root, args: ["--git-dir", remote, ...args] });
  yield* runner.run({
    command: "git",
    cwd: root,
    args: ["init", "--bare", "--initial-branch=main", remote],
  });
  const sync = yield* Sync.make.pipe(
    Effect.provide(ServerConfig.layerTest(root, path.join(root, "A"))),
  );
  yield* sync.configure(remote);
  return { sync, git };
});

it.effect("commits through the backlog clone only when Tickets changed", () =>
  Effect.gen(function* () {
    const { sync, git } = yield* gitSetup;
    const context = yield* Layer.build(
      Tickets.layer.pipe(
        Layer.provide(ProjectStore.layer),
        Layer.provideMerge(Layer.succeed(Sync.TicketSyncService)(sync)),
        Layer.provideMerge(ProjectStore.layer),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    );
    const tickets = yield* Tickets.TicketService.pipe(Effect.provideContext(context));
    const snapshot = yield* Snapshot.make.pipe(Effect.provideContext(context));
    const subjects = git(["log", "--format=%s", "main"]).pipe(
      Effect.map((out) => out.stdout.trim().split("\n")),
    );
    const show = (file: string) =>
      git(["show", `main:snapshot/${file}`]).pipe(
        Effect.map((out) => (out.code === 0 ? out.stdout : null)),
      );

    const { ticket: owned } = yield* tickets.upsert({
      title: "Fix rim light",
      projectKey: "lighting-director",
      status: "ready",
    });
    yield* tickets.entry({ id: owned.id, kind: "decision", text: "Inverse-square" });
    yield* tickets.link({ id: owned.id, threadId: ThreadId.make("thread:rim"), role: "work" });
    const { ticket: idea } = yield* tickets.upsert({ title: "Loose idea" });

    const first = yield* snapshot.run;
    assert.deepStrictEqual(first, { committed: true, files: 2 });
    const ownedFile = `lighting-director/${owned.id.slice(-6)}.md`;
    const pushed = yield* show(ownedFile);
    assert.include(pushed ?? "", `id: lighting-director-${owned.id.slice(-6)}\nulid: ${owned.id}`);
    assert.include(pushed ?? "", "decision: Inverse-square");
    assert.include(pushed ?? "", "- thread: thread:rim");
    assert.isNotNull(yield* show(`_inbox/${idea.id}.md`));
    const history = yield* subjects;
    assert.equal(history[0], "Snapshot tickets as Markdown");

    // Unchanged Tickets produce no commit.
    assert.deepStrictEqual(yield* snapshot.run, { committed: false, files: 2 });
    assert.deepStrictEqual(yield* subjects, history);

    // A deleted Ticket loses its file.
    yield* tickets.delete({ id: idea.id });
    assert.deepStrictEqual(yield* snapshot.run, { committed: true, files: 1 });
    assert.isNull(yield* show(`_inbox/${idea.id}.md`));
    assert.isNotNull(yield* show(ownedFile));

    const invalid = yield* sync.writeSnapshot(new Map([["../escape.md", "x"]])).pipe(Effect.flip);
    assert.include(invalid.message, "Invalid snapshot path");
  }).pipe(Effect.provide(Processes.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("refuses to snapshot without a backlog clone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "tickets-snapshot-local-" });
    const sync = yield* Sync.make.pipe(Effect.provide(ServerConfig.layerTest(root, root)));
    const error = yield* sync.writeSnapshot(new Map()).pipe(Effect.flip);
    assert.include(error.message, "not configured");
  }).pipe(Effect.provide(Processes.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
