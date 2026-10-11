import { useTicketWriteAllowed } from "../../state/tickets";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { allTicketsAtom, ticketEnvironment, ticketEnvironmentIdsAtom } from "../../state/tickets";
import { useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { openTicketCapture } from "../../ticketCapture";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

export function ThreadTicketChips({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const { entries } = useAtomValue(allTicketsAtom);
  const navigate = useNavigate();
  const linked = entries.filter(
    (e) => e.environmentId === environmentId && e.ticket.links.some((l) => l.threadId === threadId),
  );
  return (
    <>
      {linked.map((entry) => (
        <Badge
          key={entry.ticket.id}
          variant="outline"
          render={
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void navigate({
                  to: "/tickets",
                  search: { ticketEnvironmentId: environmentId, ticketId: entry.ticket.id },
                });
              }}
            />
          }
        >
          <span className="max-w-48 truncate">Ticket: {entry.ticket.title}</span>
        </Badge>
      ))}
    </>
  );
}
export function ThreadTicketsPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const canWrite = useTicketWriteAllowed(environmentId);
  const supported = useAtomValue(ticketEnvironmentIdsAtom).includes(environmentId);
  const { entries } = useAtomValue(allTicketsAtom);
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const link = useAtomCommand(ticketEnvironment.linkTicket);
  const unlink = useAtomCommand(ticketEnvironment.unlinkTicket);
  if (!supported || !thread) return null;
  const linked = entries.filter(
    (e) => e.environmentId === environmentId && e.ticket.links.some((l) => l.threadId === threadId),
  );
  const candidates = entries.filter(
    (e) =>
      e.environmentId === environmentId &&
      !linked.some((l) => l.ticket.id === e.ticket.id) &&
      `${e.ticket.title}\n${e.ticket.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <h3 className="text-xs font-medium text-muted-foreground">Tickets</h3>
      {linked.map((entry) => (
        <div key={entry.ticket.id} className="flex items-center justify-between gap-2">
          <ThreadTicketLink
            environmentId={environmentId}
            ticketId={entry.ticket.id}
            title={entry.ticket.title}
          />
          <Button
            size="xs"
            variant="ghost"
            disabled={!canWrite}
            onClick={() => {
              void unlink({ environmentId, input: { id: entry.ticket.id, threadId } });
            }}
          >
            Unlink
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" disabled={!canWrite} onClick={() => setOpen(true)}>
        Link to ticket…
      </Button>
      {open ? (
        <Dialog
          open
          onOpenChange={(value) => {
            if (!value && !pending) setOpen(false);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Link to ticket</DialogTitle>
              <DialogDescription>Choose a ticket for this thread.</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <Input
                autoFocus
                type="search"
                aria-label="Search tickets to link"
                placeholder="Search tickets…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="flex max-h-80 flex-col gap-1 overflow-auto">
                {candidates.map((entry) => (
                  <Button
                    key={entry.ticket.id}
                    variant="ghost"
                    disabled={pending || !canWrite}
                    onClick={() => {
                      setPending(true);
                      void link({
                        environmentId,
                        input: { id: entry.ticket.id, threadId, role: "work" },
                      }).then((result) => {
                        setPending(false);
                        if (result._tag === "Success") setOpen(false);
                      });
                    }}
                  >
                    {entry.ticket.title}
                  </Button>
                ))}
                {candidates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No matching tickets.</p>
                ) : null}
              </div>
              <Button
                variant="outline"
                disabled={pending || !canWrite}
                onClick={() => {
                  setOpen(false);
                  openTicketCapture({
                    projectRef: scopeProjectRef(environmentId, thread.projectId),
                    origin: scopeThreadRef(environmentId, threadId),
                  });
                }}
              >
                New ticket from this thread
              </Button>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}
function ThreadTicketLink({
  environmentId,
  ticketId,
  title,
}: {
  environmentId: EnvironmentId;
  ticketId: import("@t3tools/contracts").TicketId;
  title: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={() => {
        void navigate({ to: "/tickets", search: { ticketEnvironmentId: environmentId, ticketId } });
      }}
    >
      {title}
    </Button>
  );
}
