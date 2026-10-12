import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TicketError,
  TicketId,
  type TicketListResult,
  type TicketUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Tickets from "./TicketService.ts";

const layer = Tickets.layer.pipe(
  Layer.provide(Layer.mergeAll(ProjectStore.layer, NodeCrypto.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);
const input: TicketUpsertInput = {
  title: "Build tickets",
  body: "Markdown body",
  projectId: null,
  status: "ready",
  sortKey: 0.5,
};
const isTicketError = Schema.is(TicketError);
const fail = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.ok(isTicketError(error));
      return error;
    }),
  );

it.effect("creates with defaults and puts new tickets first in the active inbox", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const error = yield* fail(service.upsert({}));
    assert.equal(error.message, "Title is required to create a ticket.");
    assert.deepStrictEqual((yield* service.list()).tickets, []);
    const first = (yield* service.upsert({ title: "First" })).ticket;
    assert.equal(first.body, "");
    assert.equal(first.projectId, null);
    assert.equal(first.status, "inbox");
    assert.equal(first.sortKey, 0);
    assert.equal(first.statusSetAt, first.createdAt);
    const second = (yield* service.upsert({ title: "Second" })).ticket;
    assert.equal(second.sortKey, -1);
    yield* service.upsert({ title: "Other column", status: "ready", sortKey: -100 });
    const deleted = (yield* service.upsert({ title: "Deleted", sortKey: -200 })).ticket;
    yield* service.delete({ id: deleted.id });
    const third = (yield* service.upsert({ title: "Third" })).ticket;
    assert.equal(third.sortKey, -2);
  }).pipe(Effect.provide(layer)),
);

it.effect("partial updates preserve omitted fields and allow clearing fields", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const created = (yield* service.upsert(input)).ticket;
    yield* TestClock.adjust("1 second");
    const edited = (yield* service.upsert({ id: created.id, title: "Updated" })).ticket;
    assert.deepStrictEqual(edited, { ...created, title: "Updated", updatedAt: edited.updatedAt });
    assert.notEqual(edited.updatedAt, created.updatedAt);
    const bodyEdit = (yield* service.upsert({ id: created.id, body: "Another device's edit" }))
      .ticket;
    assert.deepStrictEqual(bodyEdit, { ...edited, body: "Another device's edit" });
    const cleared = (yield* service.upsert({
      id: created.id,
      body: "",
      sortKey: 0,
      projectId: null,
    })).ticket;
    assert.deepStrictEqual(cleared, { ...bodyEdit, body: "", sortKey: 0, projectId: null });
  }).pipe(Effect.provide(layer)),
);

it.effect("status-only updates record manual overrides even for the same status", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const created = (yield* service.upsert(input)).ticket;
    yield* TestClock.adjust("1 second");
    const same = (yield* service.upsert({ id: created.id, status: created.status })).ticket;
    assert.notEqual(same.statusSetAt, created.statusSetAt);
    assert.deepStrictEqual(same, {
      ...created,
      statusSetAt: same.updatedAt,
      updatedAt: same.updatedAt,
    });
    yield* TestClock.adjust("1 second");
    const review = (yield* service.upsert({ id: created.id, status: "in_review" })).ticket;
    assert.notEqual(review.statusSetAt, same.statusSetAt);
    assert.deepStrictEqual(review, {
      ...same,
      status: "in_review",
      statusSetAt: review.updatedAt,
      updatedAt: review.updatedAt,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("CRUD preserves creation metadata and records explicit status overrides", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const created = (yield* service.upsert({
      ...input,
      createdBy: "agent",
      creationSource: "mcp",
      originThreadId: ThreadId.make("origin"),
    })).ticket;
    yield* TestClock.adjust("1 second");
    const edited = (yield* service.upsert({
      ...input,
      id: created.id,
      status: undefined,
      title: "Updated",
    })).ticket;
    assert.equal(edited.statusSetAt, created.statusSetAt);
    assert.equal(edited.createdAt, created.createdAt);
    assert.equal(edited.createdBy, "agent");
    assert.equal(edited.creationSource, "mcp");
    assert.equal(edited.originThreadId, "origin");
    assert.notEqual(edited.updatedAt, created.updatedAt);
    yield* TestClock.adjust("1 second");
    const ready = (yield* service.upsert({ ...input, id: created.id })).ticket;
    assert.notEqual(ready.statusSetAt, created.statusSetAt);
    const review = (yield* service.upsert({ ...input, id: created.id, status: "in_review" }))
      .ticket;
    assert.equal(review.status, "in_review");
    assert.deepStrictEqual((yield* service.list()).tickets, [review]);
  }).pipe(Effect.provide(layer)),
);

it.effect("soft deletes, refuses edits/links while deleted, and restores links", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const { ticket } = yield* service.upsert(input);
    const threadId = ThreadId.make("missing-draft");
    yield* service.link({ id: ticket.id, threadId, role: "work" });
    yield* service.delete({ id: ticket.id });
    assert.deepStrictEqual((yield* service.list()).tickets, []);
    const deleted = (yield* service.list({ includeDeleted: true })).tickets[0]!;
    assert.ok(deleted.deletedAt !== null);
    assert.equal(deleted.links.length, 1);
    yield* fail(service.upsert({ id: ticket.id, status: "ready" }));
    yield* fail(service.link({ id: ticket.id, threadId, role: "origin" }));
    yield* service.delete({ id: ticket.id });
    const restored = (yield* service.restore({ id: ticket.id })).ticket;
    assert.equal(restored.deletedAt, null);
    assert.deepStrictEqual(restored.links, deleted.links);
    assert.equal(restored.statusSetAt, ticket.statusSetAt);
    assert.deepStrictEqual((yield* service.restore({ id: ticket.id })).ticket, restored);
    yield* fail(service.restore({ id: TicketId.make("missing") }));
  }).pipe(Effect.provide(layer)),
);

it.effect("links unknown threads once, changes role without relinking, and unlinks", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const { ticket } = yield* service.upsert(input);
    const link = {
      id: ticket.id,
      threadId: ThreadId.make("deleted-or-draft"),
      role: "work" as const,
    };
    const first = (yield* service.link(link)).ticket;
    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual((yield* service.link(link)).ticket, first);
    const origin = (yield* service.link({ ...link, role: "origin" })).ticket;
    assert.equal(origin.links.length, 1);
    assert.equal(origin.links[0]!.linkedAt, first.links[0]!.linkedAt);
    assert.equal(origin.links[0]!.role, "origin");
    assert.deepStrictEqual((yield* service.unlink(link)).ticket.links, []);
    assert.deepStrictEqual((yield* service.unlink(link)).ticket.links, []);
    yield* fail(service.link({ ...link, id: TicketId.make("missing") }));
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects new links to soft-deleted tickets without persisting them", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const sql = yield* SqlClient.SqlClient;
    const { ticket } = yield* service.upsert({ title: "Deleted" });
    yield* service.delete({ id: ticket.id });
    const deleted = (yield* service.list({ includeDeleted: true })).tickets[0]!;
    for (const role of ["origin", "work"] as const) {
      const error = yield* fail(
        service.link({ id: ticket.id, threadId: ThreadId.make(role), role }),
      );
      assert.equal(error.message, "Ticket not found.");
      assert.equal(error.ticketId, ticket.id);
    }
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM fork_ticket_links WHERE ticket_id = ${ticket.id}`,
      [],
    );
    assert.deepStrictEqual((yield* service.list({ includeDeleted: true })).tickets, [deleted]);
  }).pipe(Effect.provide(layer)),
);

it.effect("commandId replays creates and updates without overwriting later edits", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const create = { title: "Build tickets", commandId: CommandId.make("create") };
    const first = yield* service.upsert(create);
    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual(yield* service.upsert(create), first);
    assert.equal((yield* service.list()).tickets.length, 1);
    const update = {
      id: first.ticket.id,
      commandId: CommandId.make("update"),
      status: "in_review" as const,
    };
    const changed = yield* service.upsert(update);
    yield* TestClock.adjust("1 second");
    const latest = yield* service.upsert({ id: first.ticket.id, status: "done" });
    assert.deepStrictEqual(yield* service.upsert(update), changed);
    assert.deepStrictEqual((yield* service.list()).tickets, [latest.ticket]);
    // Receipts survive rebuilding the service over the same connection.
    const reopened = yield* Tickets.make.pipe(
      Effect.provide(Layer.mergeAll(ProjectStore.layer, NodeCrypto.layer)),
    );
    assert.deepStrictEqual(yield* reopened.upsert(create), first);
  }).pipe(Effect.provide(layer)),
);

it.effect("concurrent retries with one commandId commit only one ticket", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const command = { ...input, commandId: CommandId.make("concurrent-create") };
    const results = yield* Effect.all([service.upsert(command), service.upsert(command)], {
      concurrency: 2,
    });
    assert.deepStrictEqual(results[0], results[1]);
    assert.equal((yield* service.list()).tickets.length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("validates active projects and requires existing rows when requested", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:one");
    yield* fail(service.upsert({ ...input, projectId }));
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Project', '/tmp/tickets-project', '[]', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`;
    const created = (yield* service.upsert({ ...input, projectId })).ticket;
    assert.equal(created.projectId, projectId);
    yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-11T01:00:00.000Z' WHERE project_id = ${projectId}`;
    const edited = (yield* service.upsert({
      id: created.id,
      body: "Edited after project deletion",
    })).ticket;
    assert.equal(edited.projectId, projectId);
    assert.equal(edited.body, "Edited after project deletion");
    yield* fail(service.upsert({ id: created.id, projectId }));
    assert.equal(
      (yield* service.upsert({ id: created.id, projectId: null })).ticket.projectId,
      null,
    );
    yield* fail(service.upsert({ ...input, projectId }));
    const missing = yield* fail(
      service.upsert({ id: TicketId.make("missing"), requireExisting: true }),
    );
    assert.equal(missing.message, "Ticket not found. Restore deleted tickets before editing.");
    assert.equal((yield* service.upsert({ ...input, status: undefined })).ticket.status, "inbox");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "bootstrap runs twice, preserves rows, leaves migration ledger untouched, and cascades links",
  () =>
    Effect.gen(function* () {
      const service = yield* Tickets.TicketService;
      const sql = yield* SqlClient.SqlClient;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const { ticket } = yield* service.upsert(input);
      yield* service.link({ id: ticket.id, threadId: ThreadId.make("draft"), role: "work" });
      yield* Tickets.bootstrapSchema;
      yield* Tickets.bootstrapSchema;
      assert.equal((yield* service.list()).tickets[0]!.links.length, 1);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_schema_versions`, [
        { component: "tickets", version: 3 },
        { component: "tickets-v1-import", version: 1 },
      ]);
      yield* sql`DELETE FROM fork_tickets WHERE ticket_id = ${ticket.id}`;
      assert.deepStrictEqual(yield* sql`SELECT * FROM fork_ticket_links`, []);
    }).pipe(Effect.provide(layer)),
);

it.effect("refuses unknown schema versions without altering them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE fork_schema_versions SET version = 2 WHERE component = 'tickets'`;
    yield* fail(Tickets.bootstrapSchema);
    assert.deepStrictEqual(
      yield* sql`SELECT version FROM fork_schema_versions WHERE component = 'tickets'`,
      [{ version: 2 }],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("subscription emits full active lists after every mutation", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const snapshots = yield* Queue.unbounded<TicketListResult>();
    yield* service.subscribeList().pipe(
      Stream.runForEach((list) => Queue.offer(snapshots, list)),
      Effect.forkChild,
    );
    assert.deepStrictEqual((yield* Queue.take(snapshots)).tickets, []);
    const { ticket } = yield* service.upsert(input);
    assert.equal((yield* Queue.take(snapshots)).tickets.length, 1);
    yield* service.link({ id: ticket.id, threadId: ThreadId.make("draft"), role: "work" });
    assert.equal((yield* Queue.take(snapshots)).tickets[0]!.links.length, 1);
    yield* service.unlink({ id: ticket.id, threadId: ThreadId.make("draft") });
    assert.equal((yield* Queue.take(snapshots)).tickets[0]!.links.length, 0);
    yield* service.delete({ id: ticket.id });
    assert.deepStrictEqual((yield* Queue.take(snapshots)).tickets, []);
    yield* service.restore({ id: ticket.id });
    assert.equal((yield* Queue.take(snapshots)).tickets.length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("get and list return readable IDs that resolve back to the ticket", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const { ticket } = yield* service.upsert({
      title: "Fix rim light",
      projectKey: "lighting-director",
    });
    const idea = (yield* service.upsert({ title: "Loose idea" })).ticket;
    const readable = `lighting-director-${ticket.id.slice(-6)}`;
    assert.equal(ticket.readableId, readable);
    assert.equal(idea.readableId, null);
    assert.equal((yield* service.get(ticket.id)).ticket.readableId, readable);
    const listed = (yield* service.list()).tickets;
    assert.equal(listed.find((t) => t.id === ticket.id)?.readableId, readable);
    assert.equal(listed.find((t) => t.id === idea.id)?.readableId, null);
    // t3_ticket_get and every other id input accept the readable form, case-insensitively.
    assert.equal((yield* service.get(TicketId.make(readable))).ticket.id, ticket.id);
    assert.equal((yield* service.get(TicketId.make(readable.toLowerCase()))).ticket.id, ticket.id);
    const edited = yield* service.upsert({ id: TicketId.make(readable), body: "via readable id" });
    assert.equal(edited.ticket.id, ticket.id);
    assert.equal(edited.ticket.body, "via readable id");
    yield* fail(service.get(TicketId.make("lighting-director-ZZZZZZ")));
    yield* fail(service.get(TicketId.make(`other-project-${ticket.id.slice(-6)}`)));
  }).pipe(Effect.provide(layer)),
);

it.effect("project map keeps a moved Home's key instead of hash-suffixing it", () =>
  Effect.gen(function* () {
    const service = yield* Tickets.TicketService;
    const sql = yield* SqlClient.SqlClient;
    const insertProject = (id: ProjectId, root: string) =>
      sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${id}, 'lighting-director', ${root}, '[]', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`;
    const before = ProjectId.make("project:old-home");
    const moved = ProjectId.make("project:new-home");
    const fresh = ProjectId.make("project:fresh");
    yield* insertProject(before, "/Users/nick/Projects/lighting-director");
    yield* insertProject(moved, "/Users/nick/Projects/photography/lighting-director");
    yield* insertProject(fresh, "/Users/nick/Projects/creative/lighting-director");
    const old = (yield* service.upsert({ title: "Old ticket", projectId: before })).ticket;
    assert.equal(old.projectKey, "lighting-director");
    // An unmapped project with a taken basename gets a hash-suffixed key.
    const split = (yield* service.upsert({ title: "Split", projectId: fresh })).ticket;
    assert.match(split.projectKey ?? "", /^lighting-director-[a-z0-9]{8}$/);
    const { projects } = yield* service.projectsMap({ key: "lighting-director", projectId: moved });
    assert.equal(projects.find((p) => p.key === "lighting-director")?.projectId, moved);
    const filed = (yield* service.upsert({ title: "After move", projectId: moved })).ticket;
    assert.equal(filed.projectKey, "lighting-director");
    assert.equal(filed.projectId, moved);
    const reread = (yield* service.get(old.id)).ticket;
    assert.equal(reread.projectId, moved);
    assert.equal(reread.readableId, old.readableId);
  }).pipe(Effect.provide(layer)),
);
