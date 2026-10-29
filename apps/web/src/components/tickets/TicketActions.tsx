import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { TICKET_STATUS_LABELS } from "@t3tools/client-runtime/state/ticket-board";
import { useState } from "react";
import { ticketEnvironment, useTicketWriteAllowed } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { toastManager } from "../ui/toast";
export function TicketActions({ entry }: { entry: EnvironmentTicket }) {
  const { environmentId, ticket } = entry;
  const allowed = useTicketWriteAllowed(environmentId);
  const action = useAtomCommand(ticketEnvironment.action);
  const upsert = useAtomCommand(ticketEnvironment.upsertTicket);
  const [busy, setBusy] = useState(false);
  const narrow = useMediaQuery("(max-width: 480px)");
  const run = async (type: "accept" | "drop" | "reopen") => {
    setBusy(true);
    const result = await action({ environmentId, input: { id: ticket.id, action: type } });
    setBusy(false);
    if (result._tag === "Failure")
      toastManager.add({ type: "error", title: "Could not change ticket stage" });
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Menu>
        <MenuTrigger
          render={
            <Button
              size={narrow ? "touch" : "xs"}
              variant="outline"
              disabled={busy || !allowed}
              aria-label="Ticket stage actions"
            />
          }
        >
          {TICKET_STATUS_LABELS[ticket.status]}
        </MenuTrigger>
        <MenuPopup>
          {Object.entries(TICKET_STATUS_LABELS).map(([status, label]) => (
            <MenuItem
              key={status}
              density={narrow ? "phone" : "default"}
              onClick={() =>
                void upsert({
                  environmentId,
                  input: {
                    id: ticket.id,
                    requireExisting: true,
                    status: status as typeof ticket.status,
                  },
                })
              }
            >
              {label}
            </MenuItem>
          ))}
          {ticket.workState?.resultReady ? (
            <MenuItem onClick={() => void run("accept")}>Accept result</MenuItem>
          ) : null}
          {ticket.status === "done" || ticket.status === "dropped" ? (
            <MenuItem onClick={() => void run("reopen")}>Reopen</MenuItem>
          ) : null}
          {ticket.status !== "dropped" ? (
            <MenuItem onClick={() => void run("drop")}>Drop</MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      {ticket.workState?.resultReady ? (
        <Button
          size={narrow ? "touch" : "xs"}
          disabled={busy || !allowed}
          onClick={() => void run("accept")}
        >
          Accept
        </Button>
      ) : null}
    </div>
  );
}
