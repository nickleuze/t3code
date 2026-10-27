import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { ticketEnvironment } from "../../state/tickets";
import { useTicketConnections } from "./useTicketConnections";
import { Badge } from "../ui/badge";
export function TicketMarkers({ entry }: { entry: EnvironmentTicket }) {
  const { linked } = useTicketConnections(entry);
  const sync = useAtomValue(
    ticketEnvironment.syncStatus({ environmentId: entry.environmentId, input: {} }),
  );
  return (
    <div className="flex flex-wrap gap-1">
      {entry.ticket.workState?.blocked ? <Badge variant="warning">Blocked</Badge> : null}
      {linked.some(
        (l) => l.link.role !== "origin" && l.thread.source.pendingRuntimeRequest !== null,
      ) ? (
        <Badge variant="warning">Needs your input</Badge>
      ) : null}
      {entry.ticket.workState?.resultReady ? <Badge variant="success">Result ready</Badge> : null}
      {AsyncResult.isSuccess(sync) && sync.value.pendingTicketIds?.includes(entry.ticket.id) ? (
        <Badge variant="secondary">Pending publish</Badge>
      ) : null}
    </div>
  );
}
