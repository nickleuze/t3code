import { readmeFrontmatter } from "../project/ProjectHome.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, TicketId, type TicketEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Tickets from "./TicketService.ts";
import * as Triage from "./TicketTriage.ts";
import { ticketIds } from "./TicketRecord.ts";

const setup = (options: { ticketTriage?: boolean; mapProject?: boolean } = {}) =>
  Effect.gen(function* () {
    const calls: Triage.TriageInput[] = [];
    let verdict: Triage.TriageVerdict | null = null;
    const context = yield* Layer.build(
      Layer.mergeAll(
        Tickets.layer.pipe(Layer.provide(ProjectStore.layer)),
        ProjectStore.layer,
        Settings.layerTest({ ticketTriage: options.ticketTriage ?? true }),
        Layer.succeed(Triage.TicketTriageClassifier)({
          classify: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return verdict;
            }),
        }),
      ).pipe(Layer.provideMerge(Sqlite.layerMemory), Layer.provideMerge(NodeServices.layer)),
    );
    const provide = Effect.provideContext(context);
    const tickets = yield* Tickets.TicketService.pipe(provide);
    const sql = yield* SqlClient.SqlClient.pipe(provide);
    const fs = yield* FileSystem.FileSystem.pipe(provide);
    const path = yield* Path.Path.pipe(provide);
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ticket-triage-test-" });
    const home = path.join(root, "photography", "lighting-director");
    yield* fs.makeDirectory(path.join(home, ".git"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "photography", "AREA.md"),
      "---\narea: photography\nscope: personal\n---\n",
    );
    yield* fs.makeDirectory(path.join(root, "systems"));
    yield* fs.writeFileString(
      path.join(root, "systems", "AREA.md"),
      "---\narea: systems\nscope: personal\n---\n",
    );
    yield* fs.writeFileString(
      path.join(home, "README.md"),
      '---\nid: lighting-director\narea: photography\ngoal: "UE5 sim matches a 3-light set" # focus\n---\n# Lighting director\n',
    );
    const projectId = ProjectId.make("project:lighting");
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Lighting director', ${home}, '[]', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`;
    if (options.mapProject !== false)
      yield* tickets.projectsMap({ key: "lighting-director", projectId });
    yield* tickets.projectsMap({ key: "systems", projectId: null });
    const worker = yield* Triage.make.pipe(provide);
    const triage = (title: string, body = "") =>
      Effect.gen(function* () {
        const { ticket } = yield* tickets.upsert({ title, body });
        yield* worker.triage(ticket.id);
        yield* worker.drain;
        const state = yield* tickets.get(ticket.id);
        const { events } = yield* tickets.timeline({ id: ticket.id });
        return {
          ticket: state.ticket,
          entries: events.flatMap((e) => (e.type === "entry" ? [e] : [])),
        };
      });
    return {
      fs,
      path,
      home,
      root,
      sql,
      projectId,
      tickets,
      worker,
      calls,
      triage,
      setVerdict: (next: Triage.TriageVerdict | null) => {
        verdict = next;
      },
    };
  });

it.effect("finds a registered Project Home before its first Ticket creates a key", () =>
  Effect.gen(function* () {
    const { triage } = yield* setup({ mapProject: false });
    const { ticket, entries } = yield* triage("Fix lighting-director rim falloff");
    assert.equal(ticket.projectKey, "lighting-director");
    assert.equal(ticket.status, "ready");
    assert.equal(entries[0]?.kind, "decision");
  }).pipe(Effect.scoped),
);

it.effect("discovers an unregistered Home while excluding Area repos and non-Homes", () =>
  Effect.gen(function* () {
    const { fs, path, root, tickets, triage, calls, setVerdict } = yield* setup();
    const home = path.join(root, "life", "personal");
    yield* fs.makeDirectory(path.join(home, ".git"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "life", "AREA.md"),
      "---\narea: life\nscope: personal\n---\n",
    );
    yield* fs.writeFileString(path.join(home, "README.md"), "---\nid: personal\narea: life\n---\n");
    const plumbing = path.join(root, "photography", "backlog");
    yield* fs.makeDirectory(path.join(plumbing, ".git"), { recursive: true });
    yield* fs.writeFileString(
      path.join(plumbing, "README.md"),
      "---\nid: backlog\narea: photography\narea_repo: true\n---\n",
    );
    yield* tickets.projectsMap({ key: "backlog", projectId: null });
    setVerdict({ kind: "match", projectKey: "personal", reason: "household work" });
    const { ticket } = yield* triage("Sort the grocery list");
    assert.equal(ticket.projectKey, "personal");
    assert.equal(ticket.status, "ready");
    assert.isFalse(calls[0]!.candidates.some((c) => c.key === "backlog"));
  }).pipe(Effect.scoped),
);

it.effect("records a delegated match even if the agent omits its decision entry", () =>
  Effect.gen(function* () {
    const { tickets, worker, triage, setVerdict } = yield* setup();
    const thread = ThreadId.make("triage-thread");
    setVerdict({ kind: "delegated", threadId: thread });
    const { ticket } = yield* triage("Calibrate a softbox");
    const subscription = yield* tickets.subscribeChanges;
    yield* tickets.upsert(
      { id: ticket.id, projectKey: "lighting-director", status: "ready" },
      tickets.author({ actor: "agent", thread }),
    );
    yield* worker.onChange(yield* PubSub.take(subscription));
    yield* worker.drain;
    const entries = (yield* tickets.timeline({ id: ticket.id })).events.filter(
      (e) => e.type === "entry",
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "decision");
    assert.include(entries[0]?.text ?? "", "lighting-director");
    const repeated = yield* PubSub.takeAll(subscription);
    for (const change of repeated) yield* worker.onChange(change);
    yield* worker.drain;
    assert.equal(
      (yield* tickets.timeline({ id: ticket.id })).events.filter((e) => e.type === "entry").length,
      1,
    );
  }).pipe(Effect.scoped),
);

it.effect("files an Idea that names one Project without asking the classifier", () =>
  Effect.gen(function* () {
    const { triage, calls } = yield* setup();
    const { ticket, entries } = yield* triage("Fix Lighting-Director rim falloff");
    assert.equal(ticket.projectKey, "lighting-director");
    assert.equal(ticket.status, "ready");
    assert.equal(ticket.readableId, `lighting-director-${ticket.id.slice(-6)}`);
    assert.equal(calls.length, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.kind, "decision");
    assert.equal(entries[0]!.by.actor, "agent");
    assert.match(entries[0]!.text, /^Triage: filed under lighting-director/);
  }).pipe(Effect.scoped),
);

it.effect("keeps a moved Home's existing Ticket key and readable IDs", () =>
  Effect.gen(function* () {
    const { fs, path, home, root, sql, projectId, tickets, triage } = yield* setup();
    const existing = (yield* tickets.upsert({ title: "Existing", projectKey: "lighting-director" }))
      .ticket;
    const moved = path.join(root, "photography", "renamed-home");
    yield* fs.rename(home, moved);
    yield* fs.writeFileString(
      path.join(moved, "README.md"),
      "---\nid: renamed-home\narea: photography\n---\n",
    );
    yield* sql`UPDATE projection_projects SET workspace_root = ${moved} WHERE project_id = ${projectId}`;
    const { ticket } = yield* triage("Fix renamed-home migration");
    assert.equal(ticket.projectKey, "lighting-director");
    assert.equal((yield* tickets.get(existing.id)).ticket.readableId, existing.readableId);
    assert.equal(ticket.readableId, `lighting-director-${ticket.id.slice(-6)}`);
  }).pipe(Effect.scoped),
);

it.effect("repairs missing decisions on startup and preserves explicit classifier decisions", () =>
  Effect.gen(function* () {
    const { tickets, worker, calls } = yield* setup();
    const author = tickets.author({ actor: "agent", thread: ThreadId.make("classifier") });
    const missing = (yield* tickets.upsert({ title: "Missing verdict" })).ticket;
    const explicit = (yield* tickets.upsert({ title: "Explicit verdict" })).ticket;
    yield* tickets.upsert(
      { id: missing.id, projectKey: "lighting-director", status: "ready" },
      author,
    );
    yield* tickets.entry(
      { id: explicit.id, kind: "decision", text: "Lighting because softboxes." },
      author,
    );
    yield* tickets.upsert(
      { id: explicit.id, projectKey: "lighting-director", status: "ready" },
      author,
    );
    yield* worker.start;
    yield* worker.onChange({ ids: [missing.id, explicit.id], created: [] });
    for (const ticket of [missing, explicit]) {
      const entries = (yield* tickets.timeline({ id: ticket.id })).events.filter(
        (e) => e.type === "entry",
      );
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.kind, "decision");
    }
    assert.equal(calls.length, 0);
  }).pipe(Effect.scoped),
);

it.effect("gives the classifier candidates with README area and goal", () =>
  Effect.gen(function* () {
    const { triage, calls, setVerdict } = yield* setup();
    setVerdict({ kind: "match", projectKey: "lighting-director", reason: "softboxes are lights" });
    const { ticket, entries } = yield* triage("Calibrate the softbox simulation");
    assert.equal(ticket.status, "ready");
    assert.equal(ticket.projectKey, "lighting-director");
    assert.match(entries[0]!.text, /because softboxes are lights\.$/);
    assert.deepStrictEqual(
      calls[0]!.candidates.find((c) => c.key === "lighting-director"),
      {
        key: "lighting-director",
        name: "lighting-director",
        area: "photography",
        goal: "UE5 sim matches a 3-light set",
      },
    );
    assert.ok(calls[0]!.candidates.some((c) => c.key === "systems"));
  }).pipe(Effect.scoped),
);

it.effect("new Projects, unsure verdicts and unknown keys stay in the Inbox for Nick", () =>
  Effect.gen(function* () {
    const { triage, setVerdict } = yield* setup();
    setVerdict({ kind: "new_project", reason: "nothing like it exists", suggestedName: "Drone" });
    const fresh = yield* triage("Build a drone rig");
    assert.equal(fresh.ticket.status, "inbox");
    assert.equal(fresh.ticket.projectKey, null);
    assert.equal(fresh.entries[0]!.kind, "question");
    assert.match(fresh.entries[0]!.text, /^Needs Nick: this looks like a new Project \("Drone"\)/);

    setVerdict({ kind: "unsure", reason: "could be infra or photo", bestGuess: "systems" });
    const unsure = yield* triage("Back up the catalog");
    assert.equal(unsure.ticket.status, "inbox");
    assert.match(unsure.entries[0]!.text, /Best guess: systems\. could be infra or photo\.$/);

    // Agents never create Projects: an unknown key is only a guess.
    setVerdict({ kind: "match", projectKey: "drone-rig", reason: "sounds new" });
    const unknown = yield* triage("Prop up a gimbal");
    assert.equal(unknown.ticket.projectKey, null);
    assert.equal(unknown.ticket.status, "inbox");
    assert.match(unknown.entries[0]!.text, /Best guess: drone-rig \(not a known Project or Area\)/);

    setVerdict(null);
    const abstained = yield* triage("Something vague");
    assert.equal(
      abstained.entries[0]!.text,
      "Needs Nick: triage found no matching Project or Area.",
    );
  }).pipe(Effect.scoped),
);

it.effect("a likely duplicate keeps a confident match in the Inbox", () =>
  Effect.gen(function* () {
    const { tickets, triage, setVerdict } = yield* setup();
    const { ticket: existing } = yield* tickets.upsert({
      title: "Calibrate softbox simulation",
      projectKey: "lighting-director",
      status: "ready",
    });
    setVerdict({ kind: "match", projectKey: "lighting-director", reason: "lights" });
    const { ticket, entries } = yield* triage("Calibrate the softbox simulation");
    assert.equal(ticket.status, "inbox");
    assert.equal(ticket.projectKey, null);
    assert.equal(entries[0]!.kind, "question");
    assert.include(entries[0]!.text, `Possible duplicate of ${existing.readableId}.`);
  }).pipe(Effect.scoped),
);

it.effect("delegated verdicts leave the record to the agent thread", () =>
  Effect.gen(function* () {
    const { triage, setVerdict } = yield* setup();
    setVerdict({ kind: "delegated", threadId: ThreadId.make("triage-thread") });
    const { ticket, entries } = yield* triage("Sort the sock drawer");
    assert.equal(ticket.status, "inbox");
    assert.deepStrictEqual(entries, []);
  }).pipe(Effect.scoped),
);

it.effect("skips owned, non-inbox, synced and disabled Ideas", () =>
  Effect.gen(function* () {
    const { tickets, worker, calls } = yield* setup();
    const owned = (yield* tickets.upsert({ title: "Owned", projectKey: "systems" })).ticket;
    const ready = (yield* tickets.upsert({ title: "Ready", status: "ready" })).ticket;
    const ids = ticketIds();
    const synced = TicketId.make(ids(5_000));
    const created: TicketEvent = {
      ticketId: synced,
      eventId: `${ids(5_001)}-other-mac`,
      at: "1970-01-01T00:00:05.001Z",
      by: { actor: "user", machine: "other-mac" },
      type: "created",
      title: "Captured on the other Mac",
      body: "",
      projectKey: null,
      source: "web",
      originThread: null,
    };
    yield* tickets.importEvents([created]);
    for (const id of [owned.id, ready.id, synced]) yield* worker.triage(id);
    yield* worker.drain;
    assert.equal(calls.length, 0);
    for (const id of [owned.id, ready.id, synced])
      assert.equal(
        (yield* tickets.timeline({ id })).events.filter((e) => e.type === "entry").length,
        0,
      );

    const disabled = yield* setup({ ticketTriage: false });
    const { entries } = yield* disabled.triage("Fix lighting-director falloff");
    assert.deepStrictEqual(entries, []);
  }).pipe(Effect.scoped),
);

it.effect("reacts only to created changes, so its own edits never retrigger it", () =>
  Effect.gen(function* () {
    const { tickets, worker, calls, setVerdict } = yield* setup();
    setVerdict({ kind: "match", projectKey: "systems", reason: "infra" });
    const subscription = yield* tickets.subscribeChanges;
    const { ticket } = yield* tickets.upsert({ title: "Rotate the backup keys" });
    const change = yield* PubSub.take(subscription);
    assert.deepStrictEqual(change.created, [ticket.id]);
    yield* worker.onChange(change);
    yield* worker.drain;
    assert.equal(calls.length, 1);
    // Triage wrote a fields/stage change and an entry: neither carries `created`.
    const own = yield* PubSub.takeAll(subscription);
    assert.isAbove(own.length, 0);
    for (const next of own) {
      assert.deepStrictEqual(next.created, []);
      yield* worker.onChange(next);
    }
    yield* worker.drain;
    assert.equal(calls.length, 1);
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, "ready");
  }).pipe(Effect.scoped),
);

it("the agent prompt carries the Idea, candidates and the no-new-Projects rule", () => {
  const prompt = Triage.triagePrompt({
    idea: { id: TicketId.make("01JQ4K7QZ8R3PB5W1N0D4K7QXM"), title: "Softbox sim", body: "" },
    candidates: [{ key: "lighting-director", name: "Lighting director", area: "photography" }],
    duplicates: [],
    openTickets: [],
  });
  assert.include(prompt, "Idea 01JQ4K7QZ8R3PB5W1N0D4K7QXM: Softbox sim");
  assert.include(prompt, "- lighting-director: Lighting director, area photography");
  assert.include(prompt, "Never create a Project or an Area");
  assert.include(prompt, 'starting "Needs Nick:"');
});

it("parses README frontmatter and finds title duplicates", () => {
  assert.deepStrictEqual(readmeFrontmatter("---\narea: life\ngoal: 'Ship it'\n---\n"), {
    area: "life",
    goal: "Ship it",
  });
  assert.deepStrictEqual(readmeFrontmatter("# No frontmatter"), {});
  const open = [
    {
      id: TicketId.make("a"),
      readableId: "x-AAAAAA",
      title: "Fix rim light falloff",
      projectKey: "x",
    },
    { id: TicketId.make("b"), readableId: "x-BBBBBB", title: "Write docs", projectKey: "x" },
  ];
  assert.deepStrictEqual(
    Triage.findDuplicates({ id: TicketId.make("c"), title: "fix the rim-light falloff" }, open).map(
      (t) => t.id,
    ),
    ["a"],
  );
});
