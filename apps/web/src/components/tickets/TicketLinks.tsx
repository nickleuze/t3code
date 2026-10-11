import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import {
  ticketThreadSummary,
  ticketThreadStatus,
} from "@t3tools/client-runtime/state/ticket-board";
import { useThreadShells } from "../../state/entities";
import { ticketEnvironment, useTicketWriteAllowed } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function TicketLinks({
  entry,
  editable = false,
}: {
  entry: EnvironmentTicket;
  editable?: boolean;
}) {
  const shells = useThreadShells();
  const canWrite = useTicketWriteAllowed(entry.environmentId);
  const navigate = useNavigate();
  const unlink = useAtomCommand(ticketEnvironment.unlinkTicket);
  const getThread = (id: import("@t3tools/contracts").ThreadId) =>
    shells.find((s) => s.environmentId === entry.environmentId && s.id === id && !s.deletedAt);
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
                className="block w-full truncate text-left hover:underline disabled:text-muted-foreground"
                disabled={!thread}
                onClick={() => {
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: entry.environmentId, threadId: link.threadId },
                  });
                }}
              >
                {thread?.title || "not started"}
              </button>
            </div>
            <span className="shrink-0 text-muted-foreground">
              {status}
              {editable && link.role === "origin" ? " · origin" : ""}
            </span>
            {editable ? (
              <Button
                size="xs"
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
