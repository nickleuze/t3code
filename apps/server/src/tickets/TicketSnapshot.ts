/**
 * Nightly Markdown snapshot of every Ticket into the backlog repo, so the
 * backlog stays readable without T3 (ADR 0002).
 *
 * Writes `snapshot/<projectKey>/<suffix>.md` (Ideas without a key go to
 * `snapshot/_inbox/<ULID>.md`). Output is a pure function of the ticket
 * events (plus the Project's README `area`), so unchanged Tickets produce no
 * diff. Files of deleted Tickets are removed. The commit goes through the
 * backlog clone that TicketSyncService owns.
 *
 * @module TicketSnapshot
 */
import type { Ticket, TicketError, TicketEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { projectTicket } from "./TicketRecord.ts";
import * as TicketSync from "./TicketSyncService.ts";
import * as Tickets from "./TicketService.ts";
import { readmeFrontmatter } from "./TicketTriage.ts";

export type SnapshotTicket = {
  readonly ticket: Ticket;
  readonly events: ReadonlyArray<TicketEvent>;
  readonly area?: string | undefined;
};

const segment = (value: string) =>
  value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]/, "-") || "-";
const yaml = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9 ._()/-]*$/.test(value) &&
  !value.endsWith(" ") &&
  !/^(true|false|null|yes|no|on|off|[-+]?[0-9][0-9._]*)$/i.test(value)
    ? value
    : JSON.stringify(value);
const indent = (text: string) => text.trim().split(/\r?\n/).join("\n  ");

/** The snapshot path of a Ticket, relative to `snapshot/`. */
function snapshotPath(ticket: Ticket): string {
  if (!ticket.projectKey) return `_inbox/${ticket.id}.md`;
  const readable = ticket.readableId ?? `${ticket.projectKey}-${ticket.id.slice(-6)}`;
  return `${segment(ticket.projectKey)}/${segment(readable.slice(ticket.projectKey.length + 1))}.md`;
}

/** One Ticket as Markdown with YAML frontmatter. */
export function renderTicket({ ticket, events, area }: SnapshotTicket): string {
  const front = [
    ...(ticket.projectKey && ticket.readableId ? [`id: ${yaml(ticket.readableId)}`] : []),
    `ulid: ${ticket.id}`,
    ...(area ? [`area: ${yaml(area)}`] : []),
    ...(ticket.projectKey ? [`project: ${yaml(ticket.projectKey)}`] : []),
    `status: ${ticket.status}`,
    `title: ${yaml(ticket.title)}`,
  ];
  const entries = events
    .flatMap((event) => (event.type === "entry" ? [event] : []))
    .sort((a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId))
    .map(
      (entry) =>
        `- ${entry.at.slice(0, 10)} ${entry.kind}: ${indent(entry.text)}${
          entry.next?.trim() ? `\n  Next: ${indent(entry.next)}` : ""
        }`,
    );
  const links = [
    ...new Set(
      (projectTicket(events)?.references ?? []).map(
        (link) =>
          `- ${link.kind}: ${link.ref}${link.title?.trim() ? ` — ${link.title.trim()}` : ""} (${link.role})`,
      ),
    ),
  ].sort();
  return [
    "---",
    ...front,
    "---",
    "",
    `# ${ticket.title}`,
    ...(ticket.body.trim() ? ["", ticket.body.trim()] : []),
    ...(entries.length ? ["", "## Entries", "", ...entries] : []),
    ...(links.length ? ["", "## Links", "", ...links] : []),
    "",
  ].join("\n");
}

/** Every live Ticket's file, keyed by path relative to `snapshot/`, in path order. */
export function renderSnapshot(tickets: ReadonlyArray<SnapshotTicket>): Map<string, string> {
  return new Map(
    tickets
      .filter(({ ticket }) => ticket.deletedAt === null)
      .map((entry) => [snapshotPath(entry.ticket), renderTicket(entry)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Local calendar day, so the nightly run happens once per day wherever the Mac is. */
const localDay = (now: DateTime.DateTime) =>
  DateTime.formatIsoDate(DateTime.setZone(now, DateTime.zoneMakeLocal()));

export class TicketSnapshot extends Context.Service<
  TicketSnapshot,
  {
    /** Writes and commits the snapshot now; `committed` is false when nothing changed. */
    readonly run: Effect.Effect<
      { readonly committed: boolean; readonly files: number },
      TicketError
    >;
  }
>()("t3/tickets/TicketSnapshot") {}

export const make = Effect.gen(function* () {
  const tickets = yield* Tickets.TicketService;
  const sync = yield* TicketSync.TicketSyncService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const areas = Effect.gen(function* () {
    const result = new Map<string, string>();
    for (const project of (yield* tickets.projectsList).projects) {
      if (project.projectId === null) continue;
      const row = yield* projects.get(project.projectId).pipe(Effect.orElseSucceed(Option.none));
      if (Option.isNone(row)) continue;
      const readme = yield* fs
        .readFileString(path.join(row.value.workspaceRoot, "README.md"))
        .pipe(Effect.orElseSucceed(() => ""));
      const area = readmeFrontmatter(readme).area;
      if (area) result.set(project.key, area);
    }
    return result;
  });
  const run = Effect.gen(function* () {
    // Start from the latest events so both Macs render the same files.
    yield* tickets.refresh;
    const byKey = yield* areas;
    const live = (yield* tickets.list()).tickets;
    const files = renderSnapshot(
      yield* Effect.forEach(live, (ticket) =>
        tickets.timeline({ id: ticket.id }).pipe(
          Effect.map(({ events }) => ({
            ticket,
            events,
            area: ticket.projectKey ? byKey.get(ticket.projectKey) : undefined,
          })),
        ),
      ),
    );
    const { committed } = yield* sync.writeSnapshot(files);
    return { committed, files: files.size };
  });
  return TicketSnapshot.of({ run });
});

/** Checks hourly and snapshots once per local day while the backlog repo is configured. */
const nightly = (
  snapshot: TicketSnapshot["Service"],
  sync: TicketSync.TicketSyncService["Service"],
) =>
  Effect.gen(function* () {
    let lastDay: string | null = null;
    yield* Effect.sleep("5 minutes");
    while (true) {
      const day = localDay(yield* DateTime.now);
      const configured = yield* sync.status.pipe(
        Effect.map((status) => status.configured),
        Effect.orElseSucceed(() => false),
      );
      if (day !== lastDay && configured) {
        const result = yield* Effect.result(snapshot.run);
        if (result._tag === "Success") lastDay = day;
        else yield* Effect.logWarning("tickets.snapshot.failed", { cause: result.failure });
      }
      yield* Effect.sleep("1 hour");
    }
  });

export const layer = Layer.effect(
  TicketSnapshot,
  Effect.gen(function* () {
    const service = yield* make;
    yield* nightly(service, yield* TicketSync.TicketSyncService).pipe(Effect.forkScoped);
    return service;
  }),
);
