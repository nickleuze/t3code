import * as DateTime from "effect/DateTime";
import type { Ticket, TicketStatus } from "@t3tools/contracts";

export interface TicketStatusInput {
  readonly status: TicketStatus;
  readonly statusSetAt: string;
  readonly githubIssue: { readonly state: "open" | "closed"; readonly syncedAt: string } | null;
}

/** Only shells of the ticket's linked threads are needed; missing threads contribute no signal. */
export interface TicketLinkedThreadShell {
  readonly latestRunStartedAt?: string | DateTime.Utc | null;
  readonly pullRequests?: ReadonlyArray<{ readonly linkedAt: string; readonly source?: string }>;
}

const statusRank: Record<Exclude<TicketStatus, "dropped">, number> = {
  inbox: 0,
  ready: 1,
  in_progress: 2,
  in_review: 3,
  done: 4,
};

export function deriveTicketStatus(
  ticket: TicketStatusInput,
  linkedThreadShells: ReadonlyArray<TicketLinkedThreadShell>,
): TicketStatus {
  if (ticket.status === "done" || ticket.status === "dropped") return ticket.status;
  let status = ticket.status;
  const statusSetAt = Date.parse(ticket.statusSetAt);
  const newer = (timestamp: string | DateTime.Utc | null | undefined) =>
    timestamp != null &&
    (typeof timestamp === "string" ? Date.parse(timestamp) : DateTime.toEpochMillis(timestamp)) >
      statusSetAt;
  const advance = (signal: typeof status) => {
    if (statusRank[signal] > statusRank[status]) status = signal;
  };
  for (const thread of linkedThreadShells) {
    if (newer(thread.latestRunStartedAt)) advance("in_progress");
    if (thread.pullRequests?.some((pr) => pr.source !== "stack-dismissed" && newer(pr.linkedAt)))
      advance("in_review");
  }
  if (ticket.githubIssue?.state === "closed" && newer(ticket.githubIssue.syncedAt)) return "done";
  return status;
}

export function ticketStartPrompt(ticket: Pick<Ticket, "id" | "title" | "body">): string {
  return [ticket.title, ticket.body, `This work came from T3 ticket ${ticket.id}.`]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
