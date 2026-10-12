import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import { TicketError, type TicketEvent } from "@t3tools/contracts";
import * as Sync from "./TicketSyncService.ts";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tickets from "./TicketService.ts";
const layer = Tickets.layer.pipe(
  Layer.provide(Layer.mergeAll(Projects.layer, NodeCrypto.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect.each([
  { folder: ".t3", expected: "t3" },
  { folder: "My  App!!", expected: "my-app" },
  { folder: "my---app", expected: "my-app" },
  { folder: "...", expected: "project" },
  { folder: ".t3", mapped: "-t3", expected: "-t3" },
])("project keys normalize $folder and preserve existing mappings ($expected)", (test) =>
  Effect.gen(function* () {
    const projects = yield* Projects.ProjectStoreV2;
    const tickets = yield* Tickets.TicketService;
    const projectId = ProjectId.make("project-key");
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("project-key-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-12T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: test.folder,
        workspaceRoot: `/tmp/${test.folder}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
    });
    if (test.mapped) yield* tickets.projectsMap({ key: test.mapped, projectId });
    const { ticket } = yield* tickets.upsert({ title: "Project key", projectId });
    assert.equal(ticket.projectKey, test.expected);
    assert.equal(ticket.projectId, projectId);
    assert.deepStrictEqual(
      (yield* tickets.projectsList).projects.map((project) => project.key),
      [test.expected],
    );
  }).pipe(
    Effect.provide(
      Tickets.layer.pipe(
        Layer.provideMerge(Projects.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
);

it.effect("import is idempotent, collision safe and rebuildable", () =>
  Effect.gen(function* () {
    const tickets = yield* Tickets.TicketService;
    const { ticket } = yield* tickets.upsert({ title: "Rebuild" });
    yield* tickets.entry({ id: ticket.id, kind: "decision", text: "Keep it small" });
    const before = yield* tickets.get(ticket.id);
    const events = (yield* tickets.timeline({ id: ticket.id })).events;
    yield* tickets.importEvents(events);
    yield* tickets.importEvents(events.toReversed());
    yield* tickets.rebuild;
    assert.deepStrictEqual(yield* tickets.get(ticket.id), before);
    const collision = { ...events[0]!, at: "2026-01-01T00:00:00.000Z" };
    yield* tickets.importEvents([collision]).pipe(Effect.flip);
    assert.deepStrictEqual(yield* tickets.get(ticket.id), before);
  }).pipe(Effect.provide(layer)),
);

it.effect("entry retries dedupe within caller namespace, including service rebuild", () =>
  Effect.gen(function* () {
    const tickets = yield* Tickets.TicketService;
    const { ticket } = yield* tickets.upsert({ title: "Dedupe" });
    const input = {
      id: ticket.id,
      kind: "handoff" as const,
      text: "Built",
      next: "Review",
      clientRequestId: "same",
    };
    const by = tickets.author({ actor: "agent", thread: ThreadId.make("B"), model: "fake" });
    yield* tickets.entry(input, by, "B");
    yield* TestClock.adjust("1 second");
    yield* tickets.entry(input, by, "B");
    yield* tickets.rebuild;
    yield* tickets.entry(input, by, "B");
    assert.equal(
      (yield* tickets.timeline({ id: ticket.id })).events.filter((e) => e.type === "entry").length,
      1,
    );
    yield* tickets.entry(input, by, "other");
    assert.equal(
      (yield* tickets.timeline({ id: ticket.id })).events.filter((e) => e.type === "entry").length,
      2,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "first-send start is explicit, retry safe and never moves terminal stages backwards",
  () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.TicketService;
      const { ticket } = yield* tickets.upsert({ title: "Draft" });
      const input = {
        id: ticket.id,
        threadId: ThreadId.make("draft"),
        role: "work" as const,
        startWork: true,
      };
      const started = yield* tickets.link(input);
      assert.equal(started.ticket.status, "in_progress");
      yield* tickets.link(input);
      const events = (yield* tickets.timeline({ id: ticket.id })).events;
      assert.equal(events.filter((e) => e.type === "auto").length, 1);
      assert.equal(events.filter((e) => e.type === "stage").length, 1);
      yield* tickets.upsert({ id: ticket.id, status: "in_review" });
      const again = yield* tickets.link({ ...input, threadId: ThreadId.make("resume") });
      assert.equal(again.ticket.status, "in_review");
    }).pipe(Effect.provide(layer)),
);

it.effect("v1 migration reruns without duplicates and leaves original rows and links intact", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Tickets.bootstrapSchema;
    yield* sql`INSERT INTO fork_tickets (ticket_id, project_id, title, body, status, status_set_at, sort_key, created_by, creation_source, created_at, updated_at) VALUES ('legacy', NULL, 'Existing', 'Keep', 'in_review', '2026-10-11T00:00:01.000Z', 2, 'user', 'web', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:01.000Z')`;
    yield* sql`INSERT INTO fork_ticket_links (ticket_id, thread_id, role, linked_at) VALUES ('legacy', 'original-thread', 'work', '2026-10-11T00:00:01.000Z')`;
    const original = yield* sql`SELECT * FROM fork_tickets`;
    const originalLinks = yield* sql`SELECT * FROM fork_ticket_links`;
    const tickets = yield* Tickets.make;
    const first = yield* tickets.list();
    yield* tickets.migrate;
    yield* tickets.migrate;
    yield* tickets.rebuild;
    assert.deepStrictEqual(yield* tickets.list(), first);
    assert.deepStrictEqual(yield* sql`SELECT * FROM fork_tickets`, original);
    assert.deepStrictEqual(yield* sql`SELECT * FROM fork_ticket_links`, originalLinks);
    assert.equal((yield* sql`SELECT * FROM fork_ticket_events`).length, 4);
    assert.equal(first.tickets[0]!.status, "in_review");
    assert.equal(first.tickets[0]!.links.length, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Projects.layer, NodeCrypto.layer).pipe(Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
);

it.effect("automatic sync debounces writes and retries a queued push with clocked backoff", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const failed = yield* Deferred.make<void>();
    const retried = yield* Deferred.make<void>();
    let events: TicketEvent[] = [];
    let pending = 0;
    let pushes = 0;
    let reject = true;
    let lastError: string | null = null;
    const sync = Sync.TicketSyncService.of({
      setupCheck: Effect.die("unused"),
      setLabel: () => Effect.die("unused"),
      machine: "clock",
      label: "Clock test",
      status: Effect.sync(() => ({
        configured: true,
        remote: "local-bare",
        lastPullAt: null,
        lastPushAt: null,
        pendingEvents: pending,
        lastError,
        machine: "clock",
        label: "Clock test",
      })),
      append: (input) =>
        Effect.sync(() => {
          events.push(...input);
          pending += input.length;
        }),
      localEvents: Effect.succeed([]),
      registry: Effect.succeed({}),
      machines: Effect.succeed({ clock: "Clock test" }),
      configure: () => Effect.die("unused"),
      registerProject: () => Effect.void,
      refresh: Effect.gen(function* () {
        if (!pending) {
          yield* Deferred.succeed(started, undefined);
          return events;
        }
        pushes++;
        if (reject) {
          lastError = "Push failed";
          yield* Deferred.succeed(failed, undefined);
          return yield* new TicketError({ message: lastError });
        }
        pending = 0;
        lastError = null;
        yield* Deferred.succeed(retried, undefined);
        return events;
      }),
    });
    const tickets = yield* Tickets.make.pipe(Effect.provideService(Sync.TicketSyncService, sync));
    yield* Deferred.await(started);
    yield* tickets.upsert({ title: "Queued" });
    assert.equal(pushes, 0);
    yield* TestClock.adjust("5 seconds");
    yield* Deferred.await(failed);
    assert.equal(pushes, 1);
    assert.ok(pending > 0);
    yield* TestClock.adjust("9 seconds");
    assert.equal(pushes, 1);
    reject = false;
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(retried);
    assert.equal(pushes, 2);
    assert.equal(pending, 0);
    assert.equal(lastError, null);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Projects.layer, NodeCrypto.layer).pipe(Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
);

it.effect("an ordinary pre-link leaves stage alone and does not suppress first-send start", () =>
  Effect.gen(function* () {
    const tickets = yield* Tickets.TicketService;
    const { ticket } = yield* tickets.upsert({ title: "Pre-linked draft" });
    const link = { id: ticket.id, threadId: ThreadId.make("pre-linked"), role: "work" as const };
    assert.equal((yield* tickets.link(link)).ticket.status, "inbox");
    assert.equal((yield* tickets.link({ ...link, startWork: true })).ticket.status, "in_progress");
    yield* tickets.link({ ...link, startWork: true });
    assert.equal(
      (yield* tickets.timeline({ id: ticket.id })).events.filter((e) => e.type === "link").length,
      1,
    );
    assert.equal(
      (yield* tickets.timeline({ id: ticket.id })).events.filter((event) => event.type === "auto")
        .length,
      1,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("link snapshots retain title and machine label and refresh on rename", () =>
  Effect.gen(function* () {
    const tickets = yield* Tickets.TicketService;
    const { ticket } = yield* tickets.upsert({ title: "Snapshots" });
    const input = { id: ticket.id, kind: "thread" as const, ref: "work", title: "Implementation" };
    yield* tickets.reference(input);
    yield* tickets.reference(input);
    yield* tickets.reference({ ...input, title: "Renamed" });
    const state = yield* tickets.get(ticket.id);
    assert.equal(state.references[0]?.title, "Renamed");
    assert.equal(state.references[0]?.machineLabel, "Test");
    assert.equal(state.ticket.links[0]?.title, "Renamed");
    assert.equal(
      (yield* tickets.timeline({ id: ticket.id })).events.filter((e) => e.type === "link").length,
      2,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "PR on Inbox records only; started work moves to review, merge after manual review moves done",
  () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.TicketService;
      const { ticket } = yield* tickets.upsert({ title: "PR transitions" });
      const threadId = ThreadId.make("implementation");
      yield* tickets.link({ id: ticket.id, threadId, role: "work" });
      const pr = {
        threadId,
        key: "linked-1",
        kind: "pr_linked" as const,
        ref: "https://fixture.local/pr/1",
        title: "#1: First",
      };
      yield* tickets.observe(pr);
      assert.equal((yield* tickets.get(ticket.id)).ticket.status, "inbox");
      yield* tickets.link({ id: ticket.id, threadId, role: "work", startWork: true });
      yield* tickets.observe({
        ...pr,
        key: "draft",
        ref: "https://fixture.local/pr/2",
        isDraft: true,
      });
      assert.equal((yield* tickets.get(ticket.id)).ticket.status, "in_progress");
      yield* tickets.observe({ ...pr, key: "linked-2", ref: "https://fixture.local/pr/2" });
      assert.equal((yield* tickets.get(ticket.id)).ticket.status, "in_review");
      yield* tickets.reference({
        id: ticket.id,
        kind: "pr",
        ref: "https://fixture.local/pr/2",
        title: "Renamed PR",
      });
      yield* tickets.upsert({ id: ticket.id, status: "in_review" });
      const merged = {
        threadId,
        key: "merged-2",
        kind: "pr_merged" as const,
        ref: "https://fixture.local/pr/2",
      };
      yield* tickets.observe(merged);
      assert.equal((yield* tickets.get(ticket.id)).ticket.status, "done");
      yield* tickets.action({ id: ticket.id, action: "reopen" });
      assert.equal((yield* tickets.get(ticket.id)).ticket.status, "ready");
      yield* tickets.observe(merged);
      yield* tickets.rebuild;
      assert.equal((yield* tickets.get(ticket.id)).ticket.status, "ready");
      const events = (yield* tickets.timeline({ id: ticket.id })).events;
      assert.equal(events.filter((e) => e.type === "auto" && e.kind === "pr_merged").length, 1);
      assert.equal(events.filter((e) => e.type === "stage" && e.reason === "pr_linked").length, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("result never changes stage; accept, drop and reopen carry explicit reasons", () =>
  Effect.gen(function* () {
    const tickets = yield* Tickets.TicketService;
    const { ticket } = yield* tickets.upsert({ title: "Result" });
    yield* tickets.entry(
      { id: ticket.id, kind: "result", text: "Ready for Nick" },
      tickets.author({
        actor: "agent",
        thread: ThreadId.make("result-agent"),
        model: "gpt-6.1-sol",
      }),
    );
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, "inbox");
    assert.isTrue((yield* tickets.get(ticket.id)).ticket.workState?.resultReady);
    assert.equal(
      (yield* tickets.action({ id: ticket.id, action: "accept" })).ticket.status,
      "done",
    );
    assert.equal(
      (yield* tickets.action({ id: ticket.id, action: "reopen" })).ticket.status,
      "ready",
    );
    assert.isFalse((yield* tickets.get(ticket.id)).ticket.workState?.resultReady);
    assert.equal(
      (yield* tickets.action({ id: ticket.id, action: "drop" })).ticket.status,
      "dropped",
    );
    assert.equal(
      (yield* tickets.action({ id: ticket.id, action: "reopen" })).ticket.status,
      "ready",
    );
    assert.deepStrictEqual(
      (yield* tickets.timeline({ id: ticket.id })).events
        .filter((e) => e.type === "stage")
        .map((e) => e.reason),
      ["accepted", "reopen", "dropped", "reopen"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("planning start and non-PR observations do not move stages; goal/task refs persist", () =>
  Effect.gen(function* () {
    const tickets = yield* Tickets.TicketService;
    const { ticket } = yield* tickets.upsert({ title: "Planning" });
    const threadId = ThreadId.make("plan");
    yield* tickets.link({ id: ticket.id, threadId, role: "planning", startWork: true });
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, "inbox");
    for (const kind of [
      "thread_settled",
      "needs_input",
      "goal_iteration_done",
      "task_done",
      "pr_closed",
    ] as const)
      yield* tickets.observe({ threadId, key: kind, kind, ref: threadId });
    for (const referenceKind of ["goal", "task"] as const)
      yield* tickets.observe({
        threadId,
        key: referenceKind,
        kind: "thread_started",
        ref: referenceKind,
        referenceKind,
        title: `${referenceKind} title`,
      });
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, "inbox");
    assert.deepStrictEqual(
      (yield* tickets.get(ticket.id)).references.map((l) => l.kind),
      ["thread", "goal", "task"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("a superseded work thread and a closed PR do not change manual stages", () =>
  Effect.gen(function* () {
    const tickets = yield* Tickets.TicketService;
    const { ticket } = yield* tickets.upsert({ title: "Old work" });
    const old = ThreadId.make("old"),
      current = ThreadId.make("current");
    yield* tickets.link({ id: ticket.id, threadId: old, role: "work", startWork: true });
    yield* TestClock.adjust("1 second");
    yield* tickets.link({ id: ticket.id, threadId: current, role: "work", startWork: true });
    yield* tickets.observe({ threadId: old, key: "old-pr", kind: "pr_linked", ref: "old-pr" });
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, "in_progress");
    yield* tickets.observe({
      threadId: current,
      key: "closed",
      kind: "pr_closed",
      ref: "closed-pr",
    });
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, "in_progress");
  }).pipe(Effect.provide(layer)),
);

it.effect("observation queries only the reference index for an unlinked thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const queries: string[] = [];
    const counted = new Proxy(sql, {
      apply(target, thisArg, args) {
        queries.push((args[0] as TemplateStringsArray).join("?"));
        return Reflect.apply(target, thisArg, args);
      },
    });
    const tickets = yield* Tickets.make.pipe(Effect.provideService(SqlClient.SqlClient, counted));
    const { ticket } = yield* tickets.upsert({ title: "Linked record" });
    const threadId = ThreadId.make("linked");
    yield* tickets.link({ id: ticket.id, threadId, role: "work" });
    queries.length = 0;
    yield* tickets.observe({
      threadId: ThreadId.make("unlinked"),
      key: "settled",
      kind: "thread_settled",
      ref: "unlinked",
    });
    assert.equal(queries.length, 1);
    assert.include(queries[0]!, "FROM fork_ticket_record_links");
    yield* tickets.observe({ threadId, key: "settled", kind: "thread_settled", ref: threadId });
    assert.equal(
      (yield* tickets.timeline({ id: ticket.id })).events.filter(
        (e) => e.type === "auto" && e.kind === "thread_settled",
      ).length,
      1,
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Projects.layer, NodeCrypto.layer).pipe(Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
);

it.effect(
  "reference index follows unlink, deletion, restore, import and rebuild with machine isolation",
  () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.TicketService;
      const { ticket } = yield* tickets.upsert({ title: "Index" });
      const threadId = ThreadId.make("owner");
      yield* tickets.link({ id: ticket.id, threadId, role: "work" });
      for (const kind of ["goal", "task", "pr"] as const)
        yield* tickets.reference({ id: ticket.id, kind, ref: kind, role: "review", title: kind });
      assert.equal((yield* tickets.ticketsLinkedToThread(threadId, "other-machine")).length, 0);
      const original = yield* tickets.ticketsLinkedToThread(threadId, "test");
      assert.equal(original.length, 1);
      for (const kind of ["goal", "task", "pr"] as const)
        assert.equal(
          (yield* tickets.ticketsLinkedToReference(kind, kind, "test"))[0]?.reference.title,
          kind,
        );
      yield* tickets.rebuild;
      assert.deepStrictEqual(yield* tickets.ticketsLinkedToThread(threadId, "test"), original);
      yield* tickets.delete({ id: ticket.id });
      assert.equal((yield* tickets.ticketsLinkedToThread(threadId, "test")).length, 0);
      yield* tickets.restore({ id: ticket.id });
      assert.deepStrictEqual(yield* tickets.ticketsLinkedToThread(threadId, "test"), original);
      yield* tickets.unlink({ id: ticket.id, threadId });
      assert.equal((yield* tickets.ticketsLinkedToThread(threadId, "test")).length, 0);
      yield* tickets.importEvents((yield* tickets.timeline({ id: ticket.id })).events);
      yield* tickets.rebuild;
      assert.equal((yield* tickets.ticketsLinkedToThread(threadId, "test")).length, 0);
    }).pipe(Effect.provide(layer)),
);
