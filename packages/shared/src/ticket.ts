import * as DateTime from "effect/DateTime";
import type { ThreadId, Ticket, TicketAuthor, TicketEvent, TicketStatus } from "@t3tools/contracts";

/** The same entry interpretation feeds the projection, agent brief and detail view. */
export function deriveTicketWorkState(events: readonly TicketEvent[], status: TicketStatus) {
  const ordered = [...events].sort((a, b) => a.eventId.localeCompare(b.eventId));
  const entries = ordered
    .filter((e) => e.type === "entry")
    .sort((a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId));
  const superseded = new Set(entries.flatMap((e) => e.supersedes ?? []));
  const resolved = new Set(entries.flatMap((e) => e.resolves ?? []));
  const active = (e: (typeof entries)[number]) =>
    !superseded.has(e.eventId) && !resolved.has(e.eventId);
  const latestByThread = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (entry.by.thread && ["blocker", "progress", "result", "handoff"].includes(entry.kind))
      latestByThread.set(JSON.stringify([entry.by.machine, entry.by.thread ?? null]), entry);
  }
  const decisions = entries.filter((e) => e.kind === "decision" && active(e));
  const entriesById = new Map(entries.map((e) => [e.eventId, e]));
  const answers = entries.flatMap((e) => {
    const question = e.resolves ? entriesById.get(e.resolves) : undefined;
    return question?.kind === "question" && active(e)
      ? [
          {
            eventId: e.eventId,
            text: e.text,
            questionEventId: question.eventId,
            question: question.text,
            at: e.at,
            by: e.by,
          },
        ]
      : [];
  });
  const brief = ordered.findLast(
    (e) => e.type === "created" || (e.type === "fields" && e.body !== undefined),
  );
  const briefSource = brief ? { eventId: brief.eventId, at: brief.at, by: brief.by } : null;

  // Closing/reopening begins a new work cycle. Starting a Run preserves its brief.
  // Manual reopening from a closed stage has the same boundary as explicit Reopen.
  let boundary = "";
  let resultBoundary = "";
  let previousStage: TicketStatus = "inbox";
  for (const event of ordered) {
    if (event.type !== "stage") continue;
    if (
      ["reopen", "accepted", "dropped"].includes(event.reason) ||
      event.stage === "done" ||
      event.stage === "dropped" ||
      previousStage === "done" ||
      previousStage === "dropped"
    )
      boundary = event.eventId;
    if (event.reason === "start_work") resultBoundary = event.eventId;
    if (event.reason !== "start_work" || previousStage === "inbox" || previousStage === "ready")
      previousStage = event.stage;
  }
  const inCycle = (e: (typeof entries)[number]) =>
    status !== "done" && status !== "dropped" && e.eventId > boundary && active(e);
  // Only a Run can replace its own blocker with a work update. Threadless entries
  // have no shared work identity, so they need an explicit resolution/supersession.
  const blockers = entries.filter(
    (e) =>
      e.kind === "blocker" &&
      inCycle(e) &&
      (!e.by.thread || latestByThread.get(JSON.stringify([e.by.machine, e.by.thread])) === e),
  );
  const questions = entries.filter((e) => e.kind === "question" && inCycle(e));
  const currentEntries = entries.filter(
    (e) => inCycle(e) && (e.kind !== "blocker" || blockers.includes(e)),
  );
  const currentEvidence = currentEntries.at(-1) ?? null;
  // Notes and answers can add evidence without changing the next action. Work
  // updates/decisions replace it, even when they deliberately leave no next step.
  const nextEntry = currentEntries.findLast(
    (e) => (e.kind !== "note" && e.kind !== "question") || e.next !== undefined,
  );
  const nextAction = nextEntry?.next?.trim()
    ? {
        eventId: nextEntry.eventId,
        text: nextEntry.next.trim(),
        at: nextEntry.at,
        by: nextEntry.by,
      }
    : null;
  return {
    entries,
    superseded,
    resolved,
    decisions,
    answers,
    briefSource,
    questions,
    blockers,
    currentEvidence,
    nextAction,
    // Legacy consumers must not receive an obsolete handoff as current context.
    lastHandoff: nextEntry?.kind === "handoff" ? nextEntry : null,
    resultReady: currentEntries.some((e) => e.kind === "result" && e.eventId > resultBoundary),
  };
}

export interface TicketStatusInput {
  readonly record?: boolean | undefined;
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
  if (ticket.record) return ticket.status;
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

export function ticketStartPrompt(
  ticket: Pick<Ticket, "id" | "readableId" | "title" | "body" | "workState">,
  branches: readonly string[] = [],
): string {
  const state = ticket.workState;
  const source = (entry: {
    eventId: string;
    at?: string | undefined;
    by?: TicketAuthor | undefined;
  }) =>
    `[${entry.eventId}; ${entry.at ?? "date unavailable"}; ${entry.by ? `${entry.by.model ?? entry.by.actor} on ${entry.by.machine}${entry.by.thread ? `; t3-thread://v1/${entry.by.thread}` : ""}` : "author unavailable"}]`;
  return [
    `T3 ticket ${ticket.id}: ${ticket.title}`,
    ticket.readableId ? `Ticket reference: ${ticket.readableId}` : "",
    ticket.body,
    state?.briefSource ? `Brief source: ${source(state.briefSource)}` : "",
    state?.decisions.length
      ? `Current decisions (recorded scope/corrections; not implementation approval):\n${state.decisions.map((d) => `- ${d.text}\n  Source: ${source(d)}`).join("\n")}`
      : "",
    state?.questions.length
      ? `Open questions:\n${state.questions.map((q) => `- ${q.text}\n  Source: ${source(q)}`).join("\n")}`
      : "",
    state?.answers?.length
      ? `Recorded question responses (answers or dismissals):\n${state.answers
          .slice(-10)
          .map(
            (a) =>
              `- ${a.question}\n  ${a.text}\n  Source: ${source(a)}; question ${a.questionEventId}`,
          )
          .join(
            "\n",
          )}${state.answers.length > 10 ? `\n${state.answers.length - 10} earlier responses are available in t3_ticket_get workState.answers.` : ""}`
      : "",
    state?.currentEvidence
      ? `Current evidence (${state.currentEvidence.kind}, ${state.currentEvidence.at}):\n${state.currentEvidence.text}`
      : state?.currentEvidence === undefined && state?.lastHandoff
        ? `Last recorded handoff (verify it is still current):\n${state.lastHandoff.text}\nNext: ${state.lastHandoff.next ?? "See handoff above"}`
        : "",
    state?.currentEvidence?.kind === "note" && state.lastHandoff
      ? `Current handoff:\n${state.lastHandoff.text}`
      : "",
    state?.nextAction
      ? `Next (${state.nextAction.at}): ${state.nextAction.text}`
      : state?.nextAction === undefined && state?.currentEvidence?.next?.trim()
        ? `Next: ${state.currentEvidence.next.trim()}`
        : state?.currentEvidence
          ? "Next: Not recorded"
          : "",
    branches.length ? `Linked branches:\n${[...new Set(branches)].join("\n")}` : "",
    state?.prs.length ? `Linked PRs/branches:\n${state.prs.join("\n")}` : "",
    "This is a launch snapshot. Read t3_ticket_get for current state and recent history before working; if the tool is unavailable, report that limitation. Follow recorded source links for plan outcomes and corrections; report unavailable source hosts or items instead of assuming their contents. Write milestone entries before the substantive final answer when permitted, using structured next for the action or decision needed. Record corrected premises and explicitly accepted scope/finish conditions as decisions with their source; use supersedes/resolves to retain history. Update outdated titles or briefs only when the correction or scope is established and the write is permitted. In plan/read-only mode do not bypass write restrictions: return the plan, corrections and needed decision in the thread for T3's outcome record. Planning decisions do not grant implementation approval. A fallback handoff request needs at most a one-line acknowledgment, not a repeated final answer. Mention this ticket in PR descriptions when a PR is authorized.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
