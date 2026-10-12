import type { TicketEvent } from "@t3tools/contracts";
import { useTicketConnections } from "./useTicketConnections";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import {
  ticketThreadSummary,
  ticketThreadStatus,
} from "@t3tools/client-runtime/state/ticket-board";
import { ticketEnvironment, useTicketWriteAllowed } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";

export function TicketLinks({
  entry,
  editable = false,
}: {
  entry: EnvironmentTicket;
  editable?: boolean;
}) {
  const narrow = useMediaQuery("(max-width: 480px)");
  const { machine, linked } = useTicketConnections(entry);
  const canWrite = useTicketWriteAllowed(entry.environmentId);
  const navigate = useNavigate();
  const unlink = useAtomCommand(ticketEnvironment.unlinkTicket);
  const getThread = (id: import("@t3tools/contracts").ThreadId) =>
    linked.find((match) => match.link.threadId === id)?.thread;
  const summaries = editable
    ? entry.ticket.links.map((link) => ({
        link,
        thread: getThread(link.threadId),
        status: ticketThreadStatus(getThread(link.threadId)),
      }))
    : ticketThreadSummary(entry.ticket, getThread);
  return (
    <div className="flex flex-col gap-2">
      {summaries.map(({ link, thread, status }) => (
        <div key={link.threadId} className="flex flex-col gap-1 text-xs">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <button
                type="button"
                className="block w-full truncate text-left hover:underline disabled:text-muted-foreground max-[480px]:min-h-11"
                aria-label={`Open thread ${link.title ?? thread?.title ?? link.threadId}`}
                disabled={!thread}
                onClick={() => {
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: thread!.environmentId, threadId: link.threadId },
                  });
                }}
              >
                {thread?.title || link.title || link.threadId}
              </button>
            </div>
            <span className="shrink-0 text-muted-foreground">
              {thread
                ? status
                : link.machine && link.machine !== machine
                  ? "Host offline"
                  : "Thread unavailable"}
              {editable && link.role === "origin" ? " · origin" : ""}
            </span>
            {editable ? (
              <Button
                size={narrow ? "touch" : "xs"}
                variant="ghost"
                aria-label={`Unlink ${thread?.title ?? link.threadId}`}
                disabled={!canWrite}
                onClick={() => {
                  void unlink({
                    environmentId: entry.environmentId,
                    input: { id: entry.ticket.id, threadId: link.threadId },
                  });
                }}
              >
                Unlink
              </Button>
            ) : null}
          </div>
          {thread ? (
            <div className="flex flex-wrap gap-1">
              {thread.pullRequests
                .filter((pr) => pr.source !== "stack-dismissed")
                .map((pr) => (
                  <Badge
                    key={pr.url}
                    variant="outline"
                    render={<a href={pr.url} target="_blank" rel="noreferrer" />}
                  >
                    PR #{pr.number}
                    {pr.snapshot ? ` · ${pr.snapshot.state}` : ""}
                  </Badge>
                ))}
              {thread.t3Goal ? (
                <Badge variant="info">
                  Goal · {thread.t3Goal.status} · {thread.t3Goal.iteration}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function TicketRecordLinks({
  entry,
  events,
  machines,
}: {
  entry: EnvironmentTicket;
  events: readonly TicketEvent[];
  machines: Readonly<Record<string, string>>;
}) {
  const { machine, linked } = useTicketConnections(entry);
  const navigate = useNavigate();
  const narrow = useMediaQuery("(max-width: 480px)");
  const references = new Map<string, Extract<TicketEvent, { type: "link" | "unlink" }>>();
  for (const event of events)
    if (event.type === "link" || event.type === "unlink") {
      const key = `${event.kind}:${event.machine}:${event.ref}`;
      if (event.type === "unlink") references.delete(key);
      else references.set(key, event);
    }
  const groups = new Map<string, (typeof entry.ticket.links)[number][]>();
  for (const link of entry.ticket.links) {
    const host = link.machine ?? machine ?? "unknown";
    const group = groups.get(host) ?? [];
    group.push(link);
    groups.set(host, group);
  }
  return (
    <div className="grid gap-4">
      {[...groups].map(([host, links]) => (
        <div key={host} className="grid gap-2">
          <h4 className="text-sm font-medium">
            {links[0]?.machineLabel ?? machines[host] ?? host}
          </h4>
          {links.map((link) => {
            const match = linked.find((l) => l.link === link);
            const local = host === machine || !link.machine;
            return (
              <div key={`${host}:${link.threadId}`} className="grid gap-1 text-sm">
                <p className="wrap-anywhere">
                  {link.role[0]!.toUpperCase() + link.role.slice(1)}:{" "}
                  {link.title ?? match?.thread.title ?? link.threadId}
                </p>
                {match ? (
                  <Button
                    size={narrow ? "touch" : "xs"}
                    variant="outline"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: {
                          environmentId: match.thread.environmentId,
                          threadId: link.threadId,
                        },
                      })
                    }
                  >
                    {local ? "Open on this machine" : "Open on connected host"}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {local ? "Thread unavailable on this machine" : "Host offline"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {["goal", "task", "pr"].map((kind) => {
        const refs = [...references.values()].filter((l) => l.kind === kind);
        return refs.length ? (
          <div key={kind} className="grid gap-2">
            <h4 className="text-sm font-medium">
              {kind === "pr" ? "Pull requests" : kind === "goal" ? "Goals" : "Delegated tasks"}
            </h4>
            {refs.map((ref) => (
              <div key={`${ref.machine}:${ref.ref}`} className="text-sm wrap-anywhere">
                {kind === "pr" && /^https?:\/\//.test(ref.ref) ? (
                  <a href={ref.ref} target="_blank" rel="noreferrer" className="underline">
                    {ref.title ?? ref.ref}
                  </a>
                ) : (
                  <span>{ref.title ?? ref.ref}</span>
                )}
                <p className="text-xs text-muted-foreground">
                  {ref.machineLabel ?? machines[ref.machine] ?? ref.machine}
                </p>
              </div>
            ))}
          </div>
        ) : null;
      })}
      {!entry.ticket.links.length && !references.size ? (
        <p className="text-sm text-muted-foreground">No links yet.</p>
      ) : null}
    </div>
  );
}
