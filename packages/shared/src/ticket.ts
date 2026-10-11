import * as DateTime from "effect/DateTime";
import type { ThreadId, Ticket, TicketStatus } from "@t3tools/contracts";

export interface TicketStatusInput {
  readonly status: TicketStatus;
  readonly statusSetAt: string;
  readonly githubIssue: {
    readonly state: "open" | "closed";
    readonly closedAt?: string | null | undefined;
  } | null;
  readonly links: Ticket["links"];
}

/** Only work-linked thread shells contribute signals; missing threads contribute nothing. */
export interface TicketLinkedThreadShell {
  readonly latestRunStartedAt?: string | DateTime.Utc | null | undefined;
  readonly pullRequests?:
    | ReadonlyArray<{ readonly linkedAt: string; readonly source?: string }>
    | undefined;
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
  threadShellById: (threadId: ThreadId) => TicketLinkedThreadShell | undefined,
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
  for (const link of ticket.links) {
    if (link.role !== "work") continue;
    const thread = threadShellById(link.threadId);
    if (thread === undefined) continue;
    if (newer(thread.latestRunStartedAt)) advance("in_progress");
    if (thread.pullRequests?.some((pr) => pr.source !== "stack-dismissed" && newer(pr.linkedAt)))
      advance("in_review");
  }
  if (ticket.githubIssue?.state === "closed" && newer(ticket.githubIssue.closedAt)) return "done";
  return status;
}

export function ticketStartPrompt(ticket: Pick<Ticket, "id" | "title" | "body">): string {
  return [ticket.title, ticket.body, `This work came from T3 ticket ${ticket.id}.`]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
