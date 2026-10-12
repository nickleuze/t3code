import type { Ticket, TicketEvent, TicketLink, ThreadId } from "@t3tools/contracts";
export function resumeTicketLinks(
  links: readonly TicketLink[],
  machine: string | null,
  available: ReadonlySet<ThreadId>,
) {
  return links
    .filter(
      (link) =>
        (link.role === "work" || link.role === "planning") &&
        (link.machine === machine || link.machine === undefined) &&
        available.has(link.threadId),
    )
    .toSorted(
      (a, b) => b.linkedAt.localeCompare(a.linkedAt) || b.threadId.localeCompare(a.threadId),
    );
}
export function ticketActivity(
  ticket: Ticket,
  threads: readonly { status: string; pendingRuntimeRequest: unknown }[],
) {
  if (threads.some((t) => t.pendingRuntimeRequest !== null)) return "Needs your input";
  if (threads.some((t) => t.status === "running" || t.status === "active")) return "Running";
  if (ticket.workState?.blocked) return "Blocked";
  if (ticket.workState?.resultReady) return "Result ready";
  return "Idle";
}
const AUTO_LABELS = {
  thread_started: "Thread started",
  thread_settled: "Thread settled",
  needs_input: "Needs your input",
  pr_linked: "PR linked",
  pr_merged: "PR merged",
  pr_closed: "PR closed without merging",
  goal_iteration_done: "Goal iteration completed",
  task_done: "Delegated task finished",
};
export function ticketTimelineLabel(
  event: TicketEvent,
  machines: Readonly<Record<string, string>>,
) {
  if (event.type === "link" || event.type === "unlink")
    return `${event.type === "link" ? "Linked" : "Unlinked"} ${event.kind} ${event.title ?? event.ref} on ${event.machineLabel ?? machines[event.machine] ?? event.machine}`;
  if (event.type === "auto") {
    const number = /\/(?:pull|pulls|merge_requests|pr)\/(\d+)(?:[/?#]|$)/.exec(event.ref)?.[1];
    return AUTO_LABELS[event.kind] + (event.kind.startsWith("pr_") && number ? ` #${number}` : "");
  }
  if (event.type === "entry")
    return event.kind === "result"
      ? "Result ready"
      : event.kind[0]!.toUpperCase() + event.kind.slice(1);
  if (event.type === "stage")
    return `Stage: ${event.stage.replaceAll("_", " ")} · ${event.reason.replaceAll("_", " ")}`;
  return {
    created: "Ticket captured",
    fields: "Ticket updated",
    deleted: "Ticket deleted",
    restored: "Ticket restored",
  }[event.type];
}
