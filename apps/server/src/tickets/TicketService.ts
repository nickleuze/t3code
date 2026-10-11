import {
  Ticket,
  TicketError,
  TicketId,
  TicketGithubIssue,
  TicketLink,
  type TicketDeleteInput,
  type TicketDeleteResult,
  type TicketListInput,
  type TicketListResult,
  type TicketUpsertInput,
  type TicketRestoreInput,
  type TicketLinkInput,
  type TicketUnlinkInput,
  TicketMutationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

// Fork-owned schema stays out of the integer-keyed upstream migration ledger.
// Sqlite.layerConfig completes upstream migrations before supplying this client.
export const bootstrapSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS fork_schema_versions (
      component TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL
    )`;
      const versions = yield* sql<{ version: number }>`
        SELECT version FROM fork_schema_versions WHERE component = 'tickets'
      `;
      if (versions[0] !== undefined && versions[0].version !== 1) {
        return yield* new TicketError({ message: "Unsupported fork tickets schema version." });
      }
      yield* sql`CREATE TABLE IF NOT EXISTS fork_tickets (
      ticket_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('inbox', 'ready', 'in_progress', 'in_review', 'done', 'dropped')),
      status_set_at TEXT NOT NULL,
      sort_key REAL NOT NULL,
      created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
      creation_source TEXT NOT NULL CHECK (creation_source IN ('web', 'mobile', 'mcp', 'github')),
      origin_thread_id TEXT,
      github_issue_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`;
      // No thread FK: drafts and deleted/unknown threads may be linked.
      yield* sql`CREATE TABLE IF NOT EXISTS fork_ticket_links (
      ticket_id TEXT NOT NULL REFERENCES fork_tickets(ticket_id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('work', 'origin')),
      linked_at TEXT NOT NULL,
      PRIMARY KEY (ticket_id, thread_id)
    )`;
      // Retain receipts with the ticket so delayed retries cannot overwrite later edits.
      yield* sql`CREATE TABLE IF NOT EXISTS fork_ticket_commands (
      command_id TEXT PRIMARY KEY NOT NULL,
      ticket_id TEXT NOT NULL REFERENCES fork_tickets(ticket_id) ON DELETE CASCADE,
      result_json TEXT NOT NULL
    )`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_tickets_project
      ON fork_tickets(project_id, updated_at)`;
      yield* sql`INSERT INTO fork_schema_versions (component, version)
      VALUES ('tickets', 1) ON CONFLICT (component) DO NOTHING`;
    }),
  );
});

export class TicketService extends Context.Service<
  TicketService,
  {
    // Internal persistence operations for the GitHub service; never exposed as generic RPC writes.
    readonly importGithubIssue: (
      input: TicketUpsertInput,
      issue: TicketGithubIssue,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly setGithubIssues: (
      updates: ReadonlyArray<{ id: TicketId; issue: TicketGithubIssue | null; refresh?: boolean }>,
    ) => Effect.Effect<number, TicketError>;
    readonly list: (input?: TicketListInput) => Effect.Effect<TicketListResult, TicketError>;
    readonly subscribeList: () => Stream.Stream<TicketListResult, TicketError>;
    readonly upsert: (input: TicketUpsertInput) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly delete: (input: TicketDeleteInput) => Effect.Effect<TicketDeleteResult, TicketError>;
    readonly restore: (
      input: TicketRestoreInput,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly link: (input: TicketLinkInput) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly unlink: (input: TicketUnlinkInput) => Effect.Effect<TicketMutationResult, TicketError>;
  }
>()("t3/tickets/TicketService") {}

const TicketDbRow = Schema.Struct({
  ...Struct.omit(Ticket.fields, ["links"]),
  githubIssue: Schema.NullOr(Schema.fromJsonString(TicketGithubIssue)),
});

const isTicketError = Schema.is(TicketError);
const decodeMutationJson = Schema.decodeUnknownEffect(Schema.fromJsonString(TicketMutationResult));
const encodeMutationJson = Schema.encodeEffect(Schema.fromJsonString(TicketMutationResult));
const encodeGithubIssueJson = Schema.encodeEffect(Schema.fromJsonString(TicketGithubIssue));

const mapError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isTicketError(cause)
        ? cause
        : new TicketError({ message: "Ticket operation failed.", cause }),
    ),
  );

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* bootstrapSchema.pipe(mapError);
  const changes = yield* PubSub.sliding<void>(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const selectRows = SqlSchema.findAll({
    Request: Schema.Struct({ id: Schema.optional(TicketId), includeDeleted: Schema.Boolean }),
    Result: TicketDbRow,
    execute: (input) => sql`
      SELECT ticket_id AS "id", project_id AS "projectId", title, body, status,
        status_set_at AS "statusSetAt", sort_key AS "sortKey", created_by AS "createdBy",
        creation_source AS "creationSource", origin_thread_id AS "originThreadId",
        github_issue_json AS "githubIssue", created_at AS "createdAt",
        updated_at AS "updatedAt", deleted_at AS "deletedAt"
      FROM fork_tickets
      WHERE ${sql.and([
        ...(input.id === undefined ? [] : [sql`ticket_id = ${input.id}`]),
        ...(input.includeDeleted ? [] : [sql`deleted_at IS NULL`]),
      ])}
      ORDER BY sort_key ASC, created_at ASC, ticket_id ASC
    `,
  });
  const selectLinks = SqlSchema.findAll({
    Request: Schema.Array(TicketId),
    Result: Schema.Struct({ ticketId: TicketId, ...TicketLink.fields }),
    execute: (ids) => sql`
      SELECT ticket_id AS "ticketId", thread_id AS "threadId", role, linked_at AS "linkedAt"
      FROM fork_ticket_links WHERE ${sql.in("ticket_id", ids)}
      ORDER BY linked_at ASC, thread_id ASC
    `,
  });
  const read = Effect.fn("TicketService.read")(function* (id?: TicketId, includeDeleted = false) {
    const rows = yield* selectRows({ ...(id === undefined ? {} : { id }), includeDeleted });
    if (rows.length === 0) return [];
    const links = yield* selectLinks(rows.map((row) => row.id));
    const byTicket = new Map<TicketId, TicketLink[]>();
    for (const { ticketId, ...link } of links) {
      const group = byTicket.get(ticketId) ?? [];
      group.push(link);
      byTicket.set(ticketId, group);
    }
    return rows.map((row): Ticket => ({ ...row, links: byTicket.get(row.id) ?? [] }));
  });
  const load = Effect.fn("TicketService.load")(function* (id: TicketId, includeDeleted = false) {
    const ticket = (yield* read(id, includeDeleted))[0];
    if (ticket === undefined)
      return yield* new TicketError({ message: "Ticket not found.", ticketId: id });
    return ticket;
  });
  const mutate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(
      Effect.tap(() => PubSub.publish(changes, undefined)),
      Effect.uninterruptible,
      mapError,
    );
  const list: TicketService["Service"]["list"] = (input = {}) =>
    sql.withTransaction(read(undefined, input.includeDeleted === true)).pipe(
      Effect.map((tickets) => ({ tickets })),
      mapError,
    );
  const subscribeList: TicketService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );
  const upsertEffect = (input: TicketUpsertInput) =>
    Effect.gen(function* () {
      if (input.commandId !== undefined) {
        const receipts = yield* sql<{ result_json: string }>`
            SELECT result_json FROM fork_ticket_commands WHERE command_id = ${input.commandId}
          `;
        if (receipts[0] !== undefined) {
          return yield* decodeMutationJson(receipts[0].result_json);
        }
      }
      const timestamp = yield* now;
      const id =
        input.id ?? TicketId.make(`ticket:${input.commandId ?? (yield* crypto.randomUUIDv4)}`);
      const existing = (yield* read(id, true))[0];
      if (
        (input.requireExisting === true && existing === undefined) ||
        existing?.deletedAt != null
      ) {
        return yield* new TicketError({
          message: "Ticket not found. Restore deleted tickets before editing.",
          ticketId: id,
        });
      }
      const title = input.title ?? existing?.title;
      if (title === undefined) {
        return yield* new TicketError({
          message: "Title is required to create a ticket.",
          ticketId: id,
        });
      }
      if (
        input.projectId !== undefined &&
        input.projectId !== null &&
        Option.isNone(yield* projects.get(input.projectId))
      ) {
        return yield* new TicketError({ message: "Project not found.", ticketId: id });
      }
      let sortKey = input.sortKey ?? existing?.sortKey;
      if (sortKey === undefined) {
        const rows = yield* sql<{ minSortKey: number | null }>`
            SELECT MIN(sort_key) AS "minSortKey" FROM fork_tickets
            WHERE status = 'inbox' AND deleted_at IS NULL
          `;
        const minSortKey = rows[0]?.minSortKey;
        sortKey = minSortKey == null ? 0 : minSortKey - 1;
      }
      const ticket: Ticket = {
        id,
        projectId: input.projectId === undefined ? (existing?.projectId ?? null) : input.projectId,
        title,
        body: input.body ?? existing?.body ?? "",
        status: input.status ?? existing?.status ?? "inbox",
        statusSetAt: input.status === undefined ? (existing?.statusSetAt ?? timestamp) : timestamp,
        sortKey,
        createdBy: existing?.createdBy ?? input.createdBy ?? "user",
        creationSource: existing?.creationSource ?? input.creationSource ?? "web",
        originThreadId:
          existing === undefined ? (input.originThreadId ?? null) : existing.originThreadId,
        githubIssue: existing?.githubIssue ?? null,
        links:
          existing?.links ??
          (input.creationSource === "mcp" && input.originThreadId != null
            ? [{ threadId: input.originThreadId, role: "origin", linkedAt: timestamp }]
            : []),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      };
      const row = {
        ticket_id: ticket.id,
        project_id: ticket.projectId,
        title: ticket.title,
        body: ticket.body,
        status: ticket.status,
        status_set_at: ticket.statusSetAt,
        sort_key: ticket.sortKey,
        created_by: ticket.createdBy,
        creation_source: ticket.creationSource,
        origin_thread_id: ticket.originThreadId,
        github_issue_json:
          ticket.githubIssue === null ? null : yield* encodeGithubIssueJson(ticket.githubIssue),
        created_at: ticket.createdAt,
        updated_at: ticket.updatedAt,
        deleted_at: ticket.deletedAt,
      };
      yield* sql`INSERT INTO fork_tickets ${sql.insert(row)}
      ON CONFLICT (ticket_id) DO UPDATE SET ${sql.update(row)}`;
      // MCP creation and its origin link share the receipt transaction. A retry
      // must not restore an unlinked origin or downgrade a later work link.
      if (existing === undefined) {
        for (const link of ticket.links) {
          yield* sql`INSERT INTO fork_ticket_links (ticket_id, thread_id, role, linked_at)
          VALUES (${id}, ${link.threadId}, ${link.role}, ${link.linkedAt})`;
        }
      }
      const result = { ticket };
      if (input.commandId !== undefined) {
        yield* sql`INSERT INTO fork_ticket_commands (command_id, ticket_id, result_json)
        VALUES (${input.commandId}, ${id}, ${yield* encodeMutationJson(result)})`;
      }
      return result;
    });
  const upsert: TicketService["Service"]["upsert"] = (input) => mutate(upsertEffect(input));
  const writeGithubIssue = Effect.fn("TicketService.writeGithubIssue")(function* (
    id: TicketId,
    issue: TicketGithubIssue | null,
  ) {
    yield* load(id, true);
    yield* sql`UPDATE fork_tickets SET github_issue_json = ${issue === null ? null : yield* encodeGithubIssueJson(issue)}, updated_at = ${yield* now}
      WHERE ticket_id = ${id}`;
  });
  const setGithubIssues: TicketService["Service"]["setGithubIssues"] = (updates) =>
    mutate(
      Effect.gen(function* () {
        let count = 0;
        for (const { id, issue, refresh } of updates) {
          if (refresh) {
            const current = (yield* read(id))[0];
            if (
              !current ||
              current.githubIssue === null ||
              issue === null ||
              current.githubIssue.repository !== issue.repository ||
              current.githubIssue.number !== issue.number
            )
              continue;
          }
          yield* writeGithubIssue(id, issue);
          count++;
        }
        return count;
      }),
    );
  const importGithubIssue: TicketService["Service"]["importGithubIssue"] = (input, issue) =>
    mutate(
      Effect.gen(function* () {
        const existing = (yield* read()).find(
          (ticket) =>
            ticket.githubIssue?.repository.toLowerCase() === issue.repository.toLowerCase() &&
            ticket.githubIssue.number === issue.number,
        );
        if (existing !== undefined) return { ticket: existing };
        const { ticket } = yield* upsertEffect(input);
        yield* writeGithubIssue(ticket.id, issue);
        return { ticket: yield* load(ticket.id) };
      }),
    );
  const deleteTicket: TicketService["Service"]["delete"] = (input) =>
    mutate(
      Effect.gen(function* () {
        const ticket = yield* load(input.id, true);
        if (ticket.deletedAt === null) {
          const timestamp = yield* now;
          yield* sql`UPDATE fork_tickets SET deleted_at = ${timestamp}, updated_at = ${timestamp}
        WHERE ticket_id = ${input.id}`;
        }
        return { id: input.id };
      }),
    );
  const restore: TicketService["Service"]["restore"] = (input) =>
    mutate(
      Effect.gen(function* () {
        const ticket = yield* load(input.id, true);
        if (ticket.deletedAt !== null) {
          yield* sql`UPDATE fork_tickets SET deleted_at = NULL, updated_at = ${yield* now}
        WHERE ticket_id = ${input.id}`;
        }
        return { ticket: yield* load(input.id) };
      }),
    );
  const link: TicketService["Service"]["link"] = (input) =>
    mutate(
      Effect.gen(function* () {
        const ticket = yield* load(input.id);
        const existing = ticket.links.find((link) => link.threadId === input.threadId);
        if (existing?.role !== input.role) {
          const timestamp = yield* now;
          yield* sql`INSERT INTO fork_ticket_links (ticket_id, thread_id, role, linked_at)
        VALUES (${input.id}, ${input.threadId}, ${input.role}, ${existing?.linkedAt ?? timestamp})
        ON CONFLICT (ticket_id, thread_id) DO UPDATE SET role = excluded.role`;
          yield* sql`UPDATE fork_tickets SET updated_at = ${timestamp} WHERE ticket_id = ${input.id}`;
        }
        return { ticket: yield* load(input.id) };
      }),
    );
  const unlink: TicketService["Service"]["unlink"] = (input) =>
    mutate(
      Effect.gen(function* () {
        const ticket = yield* load(input.id);
        if (ticket.links.some((link) => link.threadId === input.threadId)) {
          yield* sql`DELETE FROM fork_ticket_links WHERE ticket_id = ${input.id} AND thread_id = ${input.threadId}`;
          yield* sql`UPDATE fork_tickets SET updated_at = ${yield* now} WHERE ticket_id = ${input.id}`;
        }
        return { ticket: yield* load(input.id) };
      }),
    );
  return TicketService.of({
    list,
    importGithubIssue,
    setGithubIssues,
    subscribeList,
    upsert,
    delete: deleteTicket,
    restore,
    link,
    unlink,
  });
});

export const layer = Layer.effect(TicketService, make);
