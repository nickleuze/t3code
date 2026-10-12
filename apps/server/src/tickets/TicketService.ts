import {
  TicketError,
  TicketId,
  ThreadId,
  ProjectId,
  TicketEvent,
  TicketMutationResult,
  type Ticket,
  type TicketAuthor,
  type TicketActionInput,
  type TicketUpsertInput,
  type TicketListInput,
  type TicketListResult,
  type TicketDeleteInput,
  type TicketDeleteResult,
  type TicketRestoreInput,
  type TicketLinkInput,
  type TicketUnlinkInput,
  type TicketEntryInput,
  type TicketTimelineResult,
  type TicketProjectsResult,
  type TicketSyncStatus,
  type TicketSetupCheck,
  type TicketProjectMapInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Path from "effect/Path";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as TicketSync from "./TicketSyncService.ts";
import {
  projectTicket,
  ticketIds,
  deterministicEventId,
  migratedTicketId,
  type TicketRecordState,
} from "./TicketRecord.ts";

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
      if (versions[0] !== undefined && ![1, 3].includes(versions[0].version)) {
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
      yield* sql`CREATE TABLE IF NOT EXISTS fork_ticket_events (
        event_id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT NOT NULL, event_json TEXT NOT NULL
      )`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_ticket_events_ticket ON fork_ticket_events(ticket_id, event_id)`;
      yield* sql`CREATE TABLE IF NOT EXISTS fork_ticket_records (
        ticket_id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL
      )`;
      yield* sql`CREATE TABLE IF NOT EXISTS fork_ticket_record_links (
        ticket_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
        machine TEXT NOT NULL, reference_json TEXT NOT NULL,
        PRIMARY KEY (ticket_id, kind, ref, machine)
      )`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_fork_ticket_record_links_reference
        ON fork_ticket_record_links(kind, ref, machine)`;
      yield* sql`CREATE TABLE IF NOT EXISTS fork_ticket_project_map (
        project_key TEXT PRIMARY KEY NOT NULL, project_id TEXT
      )`;
      yield* sql`CREATE TABLE IF NOT EXISTS fork_ticket_record_commands (
        command_id TEXT PRIMARY KEY NOT NULL, result_json TEXT NOT NULL
      )`;
      yield* sql`CREATE TABLE IF NOT EXISTS fork_ticket_legacy_ids (
        legacy_id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT NOT NULL
      )`;
      yield* sql`INSERT INTO fork_schema_versions (component, version)
      VALUES ('tickets', 3) ON CONFLICT (component) DO UPDATE SET version = 3`;
    }),
  );
});

type ReferenceInput = {
  id: TicketId;
  kind: "thread" | "goal" | "task" | "pr";
  ref: string;
  role?: "work" | "origin" | "planning" | "review" | undefined;
  unlink?: boolean;
  title?: string | undefined;
};
type LinkedTicket = { id: TicketId; reference: TicketRecordState["references"][number] };
export type TicketObservation = {
  threadId: ThreadId;
  key: string;
  kind: Extract<TicketEvent, { type: "auto" }>["kind"];
  ref: string;
  title?: string | undefined;
  isDraft?: boolean;
  model?: string | undefined;
  referenceKind?: "goal" | "task";
};
export class TicketService extends Context.Service<
  TicketService,
  {
    readonly action: (input: TicketActionInput) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly ticketsLinkedToThread: (
      threadId: ThreadId,
      machine: string,
    ) => Effect.Effect<LinkedTicket[], TicketError>;
    readonly ticketsLinkedToReference: (
      kind: "goal" | "task" | "pr",
      ref: string,
      machine: string,
    ) => Effect.Effect<LinkedTicket[], TicketError>;
    readonly observe: (input: TicketObservation) => Effect.Effect<void, TicketError>;
    readonly syncRefresh: () => Effect.Effect<TicketSyncStatus, TicketError>;
    readonly setupCheck: Effect.Effect<TicketSetupCheck, TicketError>;
    readonly machineLabel: (label: string) => Effect.Effect<TicketSyncStatus, TicketError>;
    readonly syncStatus: Effect.Effect<TicketSyncStatus, TicketError>;
    readonly syncConfigure: (remote: string) => Effect.Effect<TicketSyncStatus, TicketError>;
    readonly list: (input?: TicketListInput) => Effect.Effect<TicketListResult, TicketError>;
    readonly subscribeList: () => Stream.Stream<TicketListResult, TicketError>;
    readonly upsert: (
      input: TicketUpsertInput,
      by?: TicketAuthor,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly delete: (input: TicketDeleteInput) => Effect.Effect<TicketDeleteResult, TicketError>;
    readonly restore: (
      input: TicketRestoreInput,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly link: (
      input: TicketLinkInput,
      by?: TicketAuthor,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly unlink: (
      input: TicketUnlinkInput,
      by?: TicketAuthor,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly reference: (
      input: ReferenceInput,
      by?: TicketAuthor,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly timeline: (input: {
      id: TicketId;
    }) => Effect.Effect<TicketTimelineResult, TicketError>;
    readonly get: (id: TicketId) => Effect.Effect<TicketRecordState, TicketError>;
    readonly entry: (
      input: TicketEntryInput,
      by?: TicketAuthor,
      namespace?: string,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly importEvents: (events: readonly TicketEvent[]) => Effect.Effect<void, TicketError>;
    readonly rebuild: Effect.Effect<void, TicketError>;
    readonly migrate: Effect.Effect<void, TicketError>;
    readonly refresh: Effect.Effect<void, TicketError>;
    readonly projectsList: Effect.Effect<TicketProjectsResult, TicketError>;
    readonly projectsMap: (
      input: typeof TicketProjectMapInput.Type,
    ) => Effect.Effect<TicketProjectsResult, TicketError>;
    readonly author: (by?: Omit<TicketAuthor, "machine">) => TicketAuthor;
  }
>()("t3/tickets/TicketService") {}
const isTicketError = Schema.is(TicketError);
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(TicketEvent));
const decodeProjection = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeProjection = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(TicketEvent));
const validateEvent = Schema.decodeUnknownEffect(TicketEvent);
const decodeMutation = Schema.decodeUnknownEffect(Schema.fromJsonString(TicketMutationResult));
const encodeMutation = Schema.encodeEffect(Schema.fromJsonString(TicketMutationResult));
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
  const pathOption = yield* Effect.serviceOption(Path.Path);
  const basename = Option.isSome(pathOption)
    ? pathOption.value.basename
    : (value: string) => value.replace(/\\/g, "/").split("/").findLast(Boolean) ?? "";
  const projects = yield* ProjectStore.ProjectStoreV2;
  const syncOption = yield* Effect.serviceOption(TicketSync.TicketSyncService);
  const sync = Option.getOrUndefined(syncOption);
  const projection = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2),
  );
  const titleFor = (kind: ReferenceInput["kind"], ref: string, title?: string, caller?: ThreadId) =>
    Effect.gen(function* () {
      if (title !== undefined) return title;
      if (!projection) return ref;
      if (kind === "thread") return (yield* projection.getThread(ThreadId.make(ref))).title;
      if (kind === "goal" && caller) {
        const thread = yield* projection.getThread(caller);
        if (thread.goal?.id === ref) return thread.goal.objective;
      }
      if (kind === "goal")
        return (
          (yield* projection.getGoalThreads()).find((t) => t.goal?.id === ref)?.goal?.objective ??
          ref
        );
      if (kind === "task" && caller)
        return (
          (yield* projection.getThreadRecords(caller, ["subagents"])).subagents.find(
            (task) => task.id === ref,
          )?.title ?? ref
        );
      return ref;
    }).pipe(Effect.orElseSucceed(() => ref));
  yield* bootstrapSchema.pipe(mapError);
  const changes = yield* PubSub.sliding<void>(1);
  const lock = yield* Semaphore.make(1);
  const ulid = ticketIds();
  const author = (by?: Omit<TicketAuthor, "machine">): TicketAuthor => ({
    actor: "user",
    ...by,
    machine: sync?.machine ?? "test",
  });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const base = (id: TicketId, by?: TicketAuthor) =>
    Effect.gen(function* () {
      const at = yield* now;
      const signed = by ?? author();
      return { eventId: `${ulid(Date.parse(at))}-${signed.machine}`, ticketId: id, at, by: signed };
    });
  const resolveId = (id: TicketId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        ticket_id: string;
      }>`SELECT ticket_id FROM fork_ticket_legacy_ids WHERE legacy_id = ${id}`;
      return rows[0] === undefined ? id : TicketId.make(rows[0].ticket_id);
    });
  const eventsFor = (id: TicketId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        event_json: string;
      }>`SELECT event_json FROM fork_ticket_events WHERE ticket_id = ${id} ORDER BY event_id`;
      return yield* Effect.forEach(rows, (row) => decodeEvent(row.event_json));
    });
  const writeProjection = (state: TicketRecordState) =>
    Effect.gen(function* () {
      const id = state.ticket.id;
      yield* sql`INSERT INTO fork_ticket_records (ticket_id, state_json) VALUES (${id}, ${yield* encodeProjection(state)}) ON CONFLICT (ticket_id) DO UPDATE SET state_json = excluded.state_json`;
      yield* sql`DELETE FROM fork_ticket_record_links WHERE ticket_id = ${id}`;
      if (state.ticket.deletedAt !== null) return;
      for (const reference of state.references)
        yield* sql`INSERT INTO fork_ticket_record_links (ticket_id, kind, ref, machine, reference_json)
          VALUES (${id}, ${reference.kind}, ${reference.ref}, ${reference.machine}, ${yield* encodeEvent(reference)})`;
    });
  const linkedTo = (kind: ReferenceInput["kind"], ref: string, machine: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ ticket_id: string; reference_json: string }>`
        SELECT ticket_id, reference_json FROM fork_ticket_record_links
        WHERE kind = ${kind} AND ref = ${ref} AND machine = ${machine}
        ORDER BY ticket_id`;
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          return {
            id: TicketId.make(row.ticket_id),
            reference: (yield* decodeEvent(row.reference_json)) as LinkedTicket["reference"],
          };
        }),
      );
    }).pipe(mapError);
  const ticketsLinkedToThread = (threadId: ThreadId, machine: string) =>
    linkedTo("thread", threadId, machine);
  const ticketsLinkedToReference = (kind: "goal" | "task" | "pr", ref: string, machine: string) =>
    linkedTo(kind, ref, machine);
  const importEffect = (events: readonly TicketEvent[]) =>
    Effect.gen(function* () {
      const affected = new Set<TicketId>();
      for (const event of events) {
        const validated = yield* validateEvent(event);
        const json = yield* encodeEvent(validated);
        const previous = yield* sql<{
          event_json: string;
        }>`SELECT event_json FROM fork_ticket_events WHERE event_id = ${event.eventId}`;
        if (previous[0]) {
          if (previous[0].event_json !== json)
            return yield* new TicketError({
              message: "Ticket event identity conflict. Existing event was preserved.",
            });
          continue;
        }
        yield* sql`INSERT INTO fork_ticket_events (event_id, ticket_id, event_json) VALUES (${event.eventId}, ${event.ticketId}, ${json})`;
        affected.add(event.ticketId);
      }
      for (const id of affected) {
        const state = projectTicket(yield* eventsFor(id));
        if (state !== null) yield* writeProjection(state);
      }
    });
  const importEvents = (events: readonly TicketEvent[]) =>
    lock.withPermit(sql.withTransaction(importEffect(events))).pipe(
      Effect.tap(() => PubSub.publish(changes, undefined)),
      mapError,
    );
  const readState = (id: TicketId, includeDeleted = false) =>
    Effect.gen(function* () {
      const resolved = yield* resolveId(id);
      const rows = yield* sql<{
        state_json: string;
      }>`SELECT state_json FROM fork_ticket_records WHERE ticket_id = ${resolved}`;
      const state = rows[0]
        ? ((yield* decodeProjection(rows[0].state_json)) as TicketRecordState)
        : undefined;
      if (!state || (!includeDeleted && state.ticket.deletedAt !== null))
        return yield* new TicketError({ message: "Ticket not found.", ticketId: id });
      const key = state.ticket.projectKey;
      const mapping = key
        ? yield* sql<{
            project_id: string | null;
          }>`SELECT project_id FROM fork_ticket_project_map WHERE project_key = ${key}`
        : [];
      const registry = sync ? yield* sync.registry : {};
      return {
        ...state,
        ticket: {
          ...state.ticket,
          projectId: mapping[0]?.project_id ? ProjectId.make(mapping[0].project_id) : null,
          projectName: key ? (registry[key] ?? key) : null,
        },
      };
    });
  const get = (id: TicketId) => readState(id).pipe(mapError);
  const list = (input: TicketListInput = {}) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ ticket_id: string }>`SELECT ticket_id FROM fork_ticket_records`;
      const states = yield* Effect.forEach(rows, (row) =>
        readState(TicketId.make(row.ticket_id), true),
      );
      return {
        tickets: states
          .map((state) => state.ticket)
          .filter((ticket) => input.includeDeleted || ticket.deletedAt === null)
          .sort(
            (a, b) =>
              a.sortKey - b.sortKey ||
              b.createdAt.localeCompare(a.createdAt) ||
              a.id.localeCompare(b.id),
          ),
      };
    }).pipe(mapError);
  const commitEvents = (events: readonly TicketEvent[]) =>
    Effect.gen(function* () {
      // Write files before projection. If projection fails, startup reimports them.
      if (sync) yield* sync.append(events);
      yield* importEffect(events);
    });
  const mutate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withPermit(sql.withTransaction(effect)).pipe(
      Effect.tap(() => PubSub.publish(changes, undefined)),
      Effect.uninterruptible,
      mapError,
    );
  const projectKey = (id: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* projects.get(id);
      if (Option.isNone(project)) return yield* new TicketError({ message: "Project not found." });
      const mapped = yield* sql<{
        project_key: string;
      }>`SELECT project_key FROM fork_ticket_project_map WHERE project_id = ${id} ORDER BY project_key`;
      if (mapped[0]) return mapped[0].project_key;
      const suggested =
        basename(project.value.workspaceRoot)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "") || "project";
      const taken =
        yield* sql`SELECT project_id FROM fork_ticket_project_map WHERE project_key = ${suggested}`;
      const key = taken.length
        ? `${suggested}-${deterministicEventId("project", id, "key").slice(10, 18).toLowerCase()}`
        : suggested;
      // Assigning a local project is the user's explicit mapping confirmation.
      yield* sql`INSERT INTO fork_ticket_project_map (project_key, project_id) VALUES (${key}, ${id}) ON CONFLICT (project_key) DO UPDATE SET project_id = excluded.project_id`;
      if (sync) yield* sync.registerProject(key, project.value.title);
      return key;
    });
  const upsert = (input: TicketUpsertInput, by?: TicketAuthor) =>
    mutate(
      Effect.gen(function* () {
        if (input.commandId) {
          const rows = yield* sql<{
            result_json: string;
          }>`SELECT result_json FROM fork_ticket_record_commands WHERE command_id = ${input.commandId}`;
          if (rows[0]) return yield* decodeMutation(rows[0].result_json);
        }
        const timestamp = yield* now;
        const id = input.id
          ? yield* resolveId(input.id)
          : TicketId.make(ulid(Date.parse(timestamp)));
        const rows = yield* sql<{
          ticket_id: string;
        }>`SELECT ticket_id FROM fork_ticket_records WHERE ticket_id = ${id}`;
        const existing = rows.length ? (yield* readState(id, true)).ticket : undefined;
        if ((input.requireExisting && !existing) || existing?.deletedAt != null)
          return yield* new TicketError({
            message: "Ticket not found. Restore deleted tickets before editing.",
            ticketId: id,
          });
        if (!existing && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))
          return yield* new TicketError({ message: "New ticket ids must be ULIDs.", ticketId: id });
        if (!existing && !input.title)
          return yield* new TicketError({
            message: "Title is required to create a ticket.",
            ticketId: id,
          });
        const key =
          input.projectKey !== undefined
            ? input.projectKey
            : input.projectId !== undefined
              ? input.projectId === null
                ? null
                : yield* projectKey(input.projectId)
              : (existing?.projectKey ?? null);
        const events: TicketEvent[] = [];
        if (!existing) {
          events.push({
            ...(yield* base(id, by ?? author({ actor: input.createdBy ?? "user" }))),
            type: "created",
            title: input.title!,
            body: input.body ?? "",
            projectKey: key,
            source: input.creationSource ?? "web",
            originThread: input.originThreadId ?? null,
          });
          if (input.creationSource === "mcp" && input.originThreadId)
            events.push({
              ...(yield* base(id, by)),
              type: "link",
              kind: "thread",
              ref: input.originThreadId,
              title: yield* titleFor("thread", input.originThreadId),
              machineLabel: (yield* sync ? sync.status : Effect.succeed({ label: "Test" })).label,
              role: "origin",
              machine: sync?.machine ?? "test",
            });
        }
        const fields = {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.projectId !== undefined || input.projectKey !== undefined
            ? { projectKey: key }
            : {}),
          ...(input.sortKey !== undefined ? { sortKey: input.sortKey } : {}),
        };
        if (!existing && input.sortKey === undefined)
          fields.sortKey =
            Math.min(
              1,
              ...(yield* list()).tickets.filter((t) => t.status === "inbox").map((t) => t.sortKey),
            ) - 1;
        if (Object.keys(fields).length)
          events.push({ ...(yield* base(id, by)), type: "fields", ...fields });
        if (input.status !== undefined)
          events.push({
            ...(yield* base(id, by)),
            type: "stage",
            stage: input.status,
            reason: "manual",
          });
        yield* commitEvents(events);
        const result = { ticket: (yield* readState(id)).ticket };
        if (input.commandId)
          yield* sql`INSERT INTO fork_ticket_record_commands (command_id, result_json) VALUES (${input.commandId}, ${yield* encodeMutation(result)})`;
        return result;
      }),
    );
  const reference = (input: ReferenceInput, by?: TicketAuthor) =>
    mutate(
      Effect.gen(function* () {
        const state = yield* readState(input.id);
        const id = state.ticket.id;
        const machine = sync?.machine ?? "test";
        const existing = state.references.find(
          (link) => link.kind === input.kind && link.ref === input.ref && link.machine === machine,
        );
        const role = input.role ?? "work";
        const title = yield* titleFor(input.kind, input.ref, input.title, by?.thread);
        if (input.unlink ? !existing : existing?.role === role && existing?.title === title)
          return { ticket: state.ticket };
        yield* commitEvents([
          {
            ...(yield* base(id, by)),
            type: input.unlink ? "unlink" : "link",
            kind: input.kind,
            ref: input.ref,
            role,
            machine,
            title,
            machineLabel: (yield* sync ? sync.status : Effect.succeed({ label: "Test" })).label,
          },
        ]);
        return { ticket: (yield* readState(id)).ticket };
      }),
    );
  const link = (input: TicketLinkInput, by?: TicketAuthor) =>
    input.startWork
      ? mutate(
          Effect.gen(function* () {
            const state = yield* readState(input.id);
            const id = state.ticket.id;
            const machine = sync?.machine ?? "test";
            if (
              (yield* eventsFor(id)).some(
                (event) =>
                  event.type === "auto" &&
                  event.kind === "thread_started" &&
                  event.ref === input.threadId &&
                  event.by.machine === machine,
              )
            )
              return { ticket: state.ticket };
            const events: TicketEvent[] = [];
            const title = yield* titleFor("thread", input.threadId, input.title);
            const existing = state.references.find(
              (link) =>
                link.kind === "thread" && link.ref === input.threadId && link.machine === machine,
            );
            if (!existing || existing.role !== input.role || existing.title !== title)
              events.push({
                ...(yield* base(id, by)),
                type: "link",
                kind: "thread",
                ref: input.threadId,
                role: input.role,
                machine,
                title,
                machineLabel: (yield* sync ? sync.status : Effect.succeed({ label: "Test" })).label,
              });
            if (
              input.role !== "planning" &&
              (state.ticket.status === "inbox" || state.ticket.status === "ready")
            )
              events.push({
                ...(yield* base(id, by)),
                type: "stage",
                stage: "in_progress",
                reason: "start_work",
              });
            events.push({
              ...(yield* base(id, by)),
              type: "auto",
              kind: "thread_started",
              ref: input.threadId,
            });
            yield* commitEvents(events);
            return { ticket: (yield* readState(id)).ticket };
          }),
        )
      : reference(
          {
            id: input.id,
            kind: "thread",
            ref: input.threadId,
            role: input.role,
            title: input.title,
          },
          by,
        );
  const action = (input: TicketActionInput) =>
    mutate(
      Effect.gen(function* () {
        const state = yield* readState(input.id);
        const terminal = state.ticket.status === "done" || state.ticket.status === "dropped";
        if (input.action === "reopen" && !terminal) return { ticket: state.ticket };
        if (input.action === "accept" && !state.ticket.workState?.resultReady)
          return yield* new TicketError({ message: "No result is ready to accept." });
        if (input.action === "drop" && state.ticket.status === "dropped")
          return { ticket: state.ticket };
        yield* commitEvents([
          {
            ...(yield* base(state.ticket.id)),
            type: "stage",
            stage:
              input.action === "reopen" ? "ready" : input.action === "drop" ? "dropped" : "done",
            reason:
              input.action === "accept"
                ? "accepted"
                : input.action === "drop"
                  ? "dropped"
                  : "reopen",
          },
        ]);
        return { ticket: (yield* readState(state.ticket.id)).ticket };
      }),
    );
  // Only live observers call this method. Import/rebuild never synthesize events.
  const observe = (input: TicketObservation) =>
    lock
      .withPermit(
        sql.withTransaction(
          Effect.gen(function* () {
            let changed = false;
            const machine = sync?.machine ?? "test";
            for (const { id, reference: local } of yield* ticketsLinkedToThread(
              input.threadId,
              machine,
            )) {
              if (local.role === "origin") continue;
              const state = yield* readState(id);
              const history = yield* eventsFor(id);
              const observationKey = deterministicEventId(input.threadId, input.key, machine);
              if (history.some((e) => e.type === "auto" && e.observationKey === observationKey))
                continue;
              const by = author({
                actor: "agent",
                thread: input.threadId,
                ...(input.model ? { model: input.model } : {}),
              });
              const events: TicketEvent[] = [];
              const latestWork = state.references
                .filter((l) => l.kind === "thread" && l.role === "work")
                .sort((a, b) => b.at.localeCompare(a.at) || b.eventId.localeCompare(a.eventId))[0];
              const currentWork =
                local.role === "work" &&
                latestWork?.ref === local.ref &&
                latestWork.machine === machine;
              const active =
                state.ticket.status === "in_progress" || state.ticket.status === "in_review";
              if (input.kind === "pr_linked" && input.isDraft) continue;
              if (input.kind === "pr_linked" || input.referenceKind)
                events.push({
                  ...(yield* base(id, by)),
                  type: "link",
                  kind: input.referenceKind ?? "pr",
                  ref: input.ref,
                  role: local.role,
                  machine,
                  title: input.title,
                  machineLabel: (yield* sync ? sync.status : Effect.succeed({ label: "Test" }))
                    .label,
                });
              if (
                currentWork &&
                ((input.kind === "pr_linked" && state.ticket.status === "in_progress") ||
                  (input.kind === "pr_merged" &&
                    active &&
                    history.some(
                      (e) =>
                        e.type === "auto" &&
                        e.kind === "pr_linked" &&
                        e.ref === input.ref &&
                        e.by.thread === input.threadId &&
                        e.by.machine === machine,
                    )))
              )
                events.push({
                  ...(yield* base(id, by)),
                  type: "stage",
                  stage: input.kind === "pr_merged" ? "done" : "in_review",
                  reason: input.kind,
                });
              events.push({
                ...(yield* base(id, by)),
                type: "auto",
                kind: input.kind,
                ref: input.ref,
                observationKey,
              });
              yield* commitEvents(events);
              changed = true;
            }
            return changed;
          }),
        ),
      )
      .pipe(
        Effect.tap((changed) => (changed ? PubSub.publish(changes, undefined) : Effect.void)),
        Effect.asVoid,
        Effect.uninterruptible,
        mapError,
      );
  const entry = (input: TicketEntryInput, by?: TicketAuthor, namespace = "user") =>
    mutate(
      Effect.gen(function* () {
        const state = yield* readState(input.id);
        const signed = by ?? author();
        const requestKey = input.clientRequestId
          ? deterministicEventId(namespace, input.clientRequestId, signed.machine)
          : undefined;
        const eventId = input.clientRequestId
          ? deterministicEventId(
              namespace,
              input.clientRequestId,
              signed.machine,
              Date.parse(yield* now),
            )
          : undefined;
        if (requestKey) {
          const rows = yield* sql<{
            ticket_id: string;
          }>`SELECT ticket_id FROM fork_ticket_events WHERE json_extract(event_json, '$.requestKey') = ${requestKey}`;
          if (rows[0]) {
            if (rows[0].ticket_id !== state.ticket.id)
              return yield* new TicketError({
                message: "Entry retry key was already used for another ticket.",
              });
            return { ticket: state.ticket };
          }
        }
        for (const target of [input.supersedes, input.resolves])
          if (
            target &&
            !(yield* eventsFor(state.ticket.id)).some(
              (e) => e.eventId === target && e.type === "entry",
            )
          )
            return yield* new TicketError({ message: "Entry target must belong to this ticket." });
        const { id: _id, clientRequestId: _request, ...fields } = input;
        yield* commitEvents([
          {
            ...(yield* base(state.ticket.id, signed)),
            ...(eventId ? { eventId, requestKey } : {}),
            type: "entry",
            ...fields,
          },
        ]);
        return { ticket: (yield* readState(state.ticket.id)).ticket };
      }),
    );
  const timeline = (input: { id: TicketId }) =>
    Effect.gen(function* () {
      const state = yield* readState(input.id, true);
      return {
        events: yield* eventsFor(state.ticket.id),
        machines: sync ? yield* sync.machines : { test: "Test" },
      };
    }).pipe(mapError);
  const rebuild = mutate(
    Effect.gen(function* () {
      const rows = yield* sql<{
        ticket_id: string;
      }>`SELECT DISTINCT ticket_id FROM fork_ticket_events`;
      yield* sql`DELETE FROM fork_ticket_records`;
      yield* sql`DELETE FROM fork_ticket_record_links`;
      for (const row of rows) {
        const state = projectTicket(yield* eventsFor(TicketId.make(row.ticket_id)));
        if (state) yield* writeProjection(state);
      }
    }),
  );
  const projectsList = Effect.gen(function* () {
    const registry = sync ? yield* sync.registry : {};
    const mappings = yield* sql<{
      project_key: string;
      project_id: string | null;
    }>`SELECT * FROM fork_ticket_project_map`;
    const local = yield* projects.list();
    return {
      projects: [...new Set([...Object.keys(registry), ...mappings.map((m) => m.project_key)])]
        .sort()
        .map((key) => ({
          key,
          displayName: registry[key] ?? key,
          projectId: mappings.find((m) => m.project_key === key)?.project_id
            ? ProjectId.make(mappings.find((m) => m.project_key === key)!.project_id!)
            : null,
          suggestedProjectId:
            local.find((p) => basename(p.workspaceRoot).toLowerCase() === key)?.projectId ?? null,
        })),
    };
  }).pipe(mapError);
  const projectsMap = (input: typeof TicketProjectMapInput.Type) =>
    mutate(
      Effect.gen(function* () {
        if (input.projectId !== null && Option.isNone(yield* projects.get(input.projectId)))
          return yield* new TicketError({ message: "Project not found." });
        if (sync) yield* sync.registerProject(input.key, input.displayName ?? input.key);
        yield* sql`INSERT INTO fork_ticket_project_map (project_key, project_id) VALUES (${input.key}, ${input.projectId}) ON CONFLICT (project_key) DO UPDATE SET project_id = excluded.project_id`;
        return yield* projectsList;
      }),
    );
  const migrate = mutate(
    Effect.gen(function* () {
      const done =
        yield* sql`SELECT version FROM fork_schema_versions WHERE component = 'tickets-v1-import'`;
      if (done.length) return;
      const rows = yield* sql<{
        ticket_id: string;
        title: string;
        body: string;
        project_id: string | null;
        status: Ticket["status"];
        status_set_at: string;
        sort_key: number;
        created_by: Ticket["createdBy"];
        creation_source: Ticket["creationSource"];
        origin_thread_id: string | null;
        created_at: string;
        deleted_at: string | null;
      }>`SELECT * FROM fork_tickets ORDER BY ticket_id`;
      for (const row of rows) {
        const id = migratedTicketId(row.ticket_id, row.created_at);
        const by = author({ actor: row.created_by });
        const key = row.project_id
          ? yield* projectKey(ProjectId.make(row.project_id)).pipe(Effect.orElseSucceed(() => null))
          : null;
        const migrationBase = (index: number, at: string) => ({
          ticketId: id,
          eventId: `${migratedTicketId(`${row.ticket_id}:${index}`, at)}-${by.machine}`,
          at,
          by,
        });
        const events: TicketEvent[] = [
          {
            ...migrationBase(0, row.created_at),
            type: "created",
            title: row.title,
            body: row.body,
            projectKey: key,
            source: row.creation_source,
            originThread: row.origin_thread_id ? ThreadId.make(row.origin_thread_id) : null,
          },
          {
            ...migrationBase(1, row.created_at),
            type: "fields",
            title: row.title,
            body: row.body,
            projectKey: key,
            sortKey: row.sort_key,
          },
          {
            ...migrationBase(2, row.status_set_at),
            type: "stage",
            stage: row.status,
            reason: "manual",
          },
        ];
        const links = yield* sql<{
          thread_id: string;
          role: "origin" | "work";
          linked_at: string;
        }>`SELECT * FROM fork_ticket_links WHERE ticket_id = ${row.ticket_id} ORDER BY thread_id`;
        for (const [index, link] of links.entries())
          events.push({
            ...migrationBase(3 + index, link.linked_at),
            type: "link",
            kind: "thread",
            ref: link.thread_id,
            role: link.role,
            machine: by.machine,
          });
        if (row.deleted_at)
          events.push({ ...migrationBase(3 + links.length, row.deleted_at), type: "deleted" });
        yield* commitEvents(events);
        yield* sql`INSERT INTO fork_ticket_legacy_ids (legacy_id, ticket_id) VALUES (${row.ticket_id}, ${id}) ON CONFLICT DO NOTHING`;
      }
      yield* sql`INSERT INTO fork_schema_versions (component, version) VALUES ('tickets-v1-import', 1)`;
    }),
  );
  let lastReadAt = 0;
  const refresh = sync
    ? sync.refresh.pipe(
        Effect.flatMap(importEvents),
        Effect.tap(() =>
          DateTime.now.pipe(
            Effect.tap((time) =>
              Effect.sync(() => {
                lastReadAt = DateTime.toEpochMillis(time);
              }),
            ),
          ),
        ),
      )
    : Effect.void;
  let subscribers = 0;
  const subscribeList = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            subscribers++;
          }),
          () =>
            Effect.sync(() => {
              subscribers--;
            }),
        );
        yield* refresh.pipe(Effect.ignore, Effect.forkScoped);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );
  yield* migrate;
  yield* rebuild;
  if (sync) {
    yield* sync.localEvents.pipe(Effect.flatMap(importEvents), Effect.ignore);
    yield* refresh.pipe(Effect.ignore, Effect.forkScoped);
    // One fork-contained worker owns debounce, retry backoff and pull cadence.
    yield* Effect.gen(function* () {
      let retryAt = 0;
      let failures = 0;
      while (true) {
        yield* Effect.sleep("5 seconds");
        const time = DateTime.toEpochMillis(yield* DateTime.now);
        const status = yield* sync.status;
        if (status.lastError === null) {
          failures = 0;
          retryAt = 0;
        }
        const cadence = subscribers > 0 ? 60_000 : 600_000;
        if (time < retryAt || (status.pendingEvents === 0 && time < lastReadAt + cadence)) continue;
        const result = yield* Effect.result(refresh);
        if (result._tag === "Failure") {
          failures++;
          retryAt = time + Math.min(600_000, 5_000 * 2 ** failures);
        } else {
          failures = 0;
          retryAt = 0;
        }
      }
    }).pipe(Effect.forkScoped);
  }
  const syncUnavailable = Effect.fail(
    new TicketError({ message: "Ticket sync is unavailable in this environment." }),
  );
  const syncRefresh: TicketService["Service"]["syncRefresh"] = () =>
    Effect.gen(function* () {
      yield* refresh;
      return yield* sync ? sync.status : syncUnavailable;
    });
  return TicketService.of({
    action,
    observe,
    ticketsLinkedToThread,
    ticketsLinkedToReference,
    setupCheck: sync ? sync.setupCheck : syncUnavailable,
    machineLabel: (label) => (sync ? sync.setLabel(label) : syncUnavailable),
    syncRefresh,
    syncStatus: sync ? sync.status : syncUnavailable,
    syncConfigure: (remote) =>
      sync ? sync.configure(remote).pipe(Effect.tap(() => refresh)) : syncUnavailable,
    list,
    subscribeList,
    upsert,
    get,
    author,
    timeline,
    entry,
    reference,
    link,
    unlink: (input, by) =>
      reference({ id: input.id, kind: "thread", ref: input.threadId, unlink: true }, by),
    delete: (input) =>
      mutate(
        Effect.gen(function* () {
          const state = yield* readState(input.id, true);
          if (!state.ticket.deletedAt)
            yield* commitEvents([{ ...(yield* base(state.ticket.id)), type: "deleted" }]);
          return { id: state.ticket.id };
        }),
      ),
    restore: (input) =>
      mutate(
        Effect.gen(function* () {
          const state = yield* readState(input.id, true);
          if (state.ticket.deletedAt)
            yield* commitEvents([{ ...(yield* base(state.ticket.id)), type: "restored" }]);
          return { ticket: (yield* readState(state.ticket.id)).ticket };
        }),
      ),
    importEvents,
    rebuild,
    migrate,
    refresh,
    projectsList,
    projectsMap,
  });
});
export const layer = Layer.effect(TicketService, make);
