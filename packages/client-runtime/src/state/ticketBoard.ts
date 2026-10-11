import type { EnvironmentId, ThreadId, Ticket, TicketId, TicketStatus } from "@t3tools/contracts";
import { deriveTicketStatus, type TicketLinkedThreadShell } from "@t3tools/shared/ticket";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";

export const TICKET_COLUMNS = ["inbox", "ready", "in_progress", "in_review", "done"] as const;
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  inbox: "Inbox",
  ready: "Ready",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  dropped: "Dropped",
};
export interface EnvironmentTicket {
  readonly environmentId: EnvironmentId;
  readonly ticket: Ticket;
}
export function ticketEntryKey(entry: EnvironmentTicket): string {
  return `${entry.environmentId}:${entry.ticket.id}`;
}
export function ticketSortKeyBetween(before?: number, after?: number): number {
  if (before === undefined) return after === undefined ? 0 : after - 1;
  if (after === undefined) return before + 1;
  return before / 2 + after / 2;
}
/** Usually one midpoint patch; re-space tied or exhausted keys only when necessary. */
export function ticketInsertionSortKeys(
  columnWithoutSource: ReadonlyArray<EnvironmentTicket>,
  source: EnvironmentTicket,
  insertionIndex: number,
) {
  const index = Math.max(0, Math.min(insertionIndex, columnWithoutSource.length));
  const before = columnWithoutSource[index - 1]?.ticket.sortKey;
  const after = columnWithoutSource[index]?.ticket.sortKey;
  const sortKey = ticketSortKeyBetween(before, after);
  if (
    Number.isFinite(sortKey) &&
    (before === undefined || before < sortKey) &&
    (after === undefined || sortKey < after)
  ) {
    return [{ entry: source, sortKey }];
  }
  const column = [...columnWithoutSource];
  column.splice(index, 0, source);
  return column
    .map((entry, sortKey) => ({ entry, sortKey }))
    .filter(
      (patch) =>
        ticketEntryKey(patch.entry) === ticketEntryKey(source) ||
        patch.entry.ticket.sortKey !== patch.sortKey,
    );
}
export function ticketThreadStatus(thread: EnvironmentThreadShell | undefined) {
  if (!thread || thread.deletedAt) return "not started";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasActionableProposedPlan)
    return "needs input";
  if (threadRuntimeIsActive(thread.runtime)) return "running";
  if (
    thread.settledOverride === "settled" ||
    (thread.settledOverride !== "active" && thread.settledAt !== null)
  )
    return "settled";
  return "idle";
}
export function ticketThreadSummary(
  ticket: Ticket,
  getThread: (id: ThreadId) => EnvironmentThreadShell | undefined,
) {
  return ticket.links
    .filter((link) => link.role === "work")
    .map((link) => {
      const thread = getThread(link.threadId);
      return { link, thread, status: ticketThreadStatus(thread) };
    });
}
export function groupTicketBoard(
  entries: ReadonlyArray<EnvironmentTicket>,
  options: {
    readonly threadById: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => TicketLinkedThreadShell | undefined;
    readonly environmentId?: EnvironmentId | undefined;
    readonly projectId?: string | undefined;
    readonly projectEnvironmentId?: EnvironmentId | undefined;
    readonly projectExists?: (
      environmentId: EnvironmentId,
      projectId: NonNullable<Ticket["projectId"]>,
    ) => boolean;
    readonly search?: string | undefined;
    readonly showAllDone?: boolean | undefined;
    readonly showDropped?: boolean | undefined;
    readonly deleted?: boolean | undefined;
    readonly now: number;
  },
) {
  const groups: Record<TicketStatus, EnvironmentTicket[]> = {
    inbox: [],
    ready: [],
    in_progress: [],
    in_review: [],
    done: [],
    dropped: [],
  };
  const query = options.search?.trim().toLowerCase() ?? "";
  for (const entry of entries) {
    const { ticket, environmentId } = entry;
    if ((ticket.deletedAt !== null) !== (options.deleted === true)) continue;
    if (options.environmentId && options.environmentId !== environmentId) continue;
    const projectId =
      ticket.projectId !== null &&
      options.projectExists?.(environmentId, ticket.projectId) === false
        ? null
        : ticket.projectId;
    if (options.projectId !== undefined && (projectId ?? "none") !== options.projectId) continue;
    if (
      options.projectId !== undefined &&
      options.projectEnvironmentId !== undefined &&
      environmentId !== options.projectEnvironmentId
    )
      continue;
    if (query && !`${ticket.title}\n${ticket.body}`.toLowerCase().includes(query)) continue;
    const status = deriveTicketStatus(ticket, (id) => options.threadById(environmentId, id));
    if (!options.deleted && status === "dropped" && !options.showDropped) continue;
    if (
      !options.deleted &&
      status === "done" &&
      !options.showAllDone &&
      Date.parse(ticket.updatedAt) < options.now - 14 * 86400000
    )
      continue;
    groups[status].push(entry);
  }
  for (const group of Object.values(groups))
    group.sort(
      (a, b) =>
        a.ticket.sortKey - b.ticket.sortKey || ticketEntryKey(a).localeCompare(ticketEntryKey(b)),
    );
  return groups;
}
export interface PendingTicketLink {
  readonly environmentId: EnvironmentId;
  readonly ticketId: TicketId;
  readonly threadId: ThreadId;
}
/** A server acknowledgement, not draft creation or a promotion attempt, authorizes the link. */
export function pendingTicketLinkOnPromotion(
  pending: PendingTicketLink | undefined,
  promoted: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
) {
  return pending &&
    promoted?.environmentId === pending.environmentId &&
    promoted.threadId === pending.threadId
    ? {
        environmentId: pending.environmentId,
        input: { id: pending.ticketId, threadId: promoted.threadId, role: "work" as const },
      }
    : null;
}
