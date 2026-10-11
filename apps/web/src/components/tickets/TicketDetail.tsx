import { useTicketWriteAllowed } from "../../state/tickets";
import { ProjectId, type TicketStatus } from "@t3tools/contracts";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { TICKET_STATUS_LABELS } from "@t3tools/client-runtime/state/ticket-board";
import { deriveTicketStatus } from "@t3tools/shared/ticket";
import { useState } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { ticketEnvironment } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
import { toastManager } from "../ui/toast";
import { TicketPicker } from "./TicketPicker";
import { TicketLinks } from "./TicketLinks";
import { TicketStartWork } from "./TicketStartWork";

export function TicketDetail({
  entry,
  onClose,
}: {
  entry: EnvironmentTicket;
  onClose: () => void;
}) {
  const { ticket, environmentId } = entry;
  const canWrite = useTicketWriteAllowed(environmentId);
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const shells = useThreadShells();
  const status = deriveTicketStatus(
    ticket,
    (id) => shells.find((s) => s.environmentId === environmentId && s.id === id)?.source,
  );
  const [title, setTitle] = useState(ticket.title);
  const [body, setBody] = useState(ticket.body);
  const [projectId, setProjectId] = useState<string>(
    projects.some((p) => p.id === ticket.projectId) ? ticket.projectId! : "none",
  );
  const [pickedStatus, setStatus] = useState<TicketStatus | null>(null);
  const [edited, setEdited] = useState({ title: false, body: false, project: false });
  const [busy, setBusy] = useState(false);
  const upsert = useAtomCommand(ticketEnvironment.upsertTicket);
  const remove = useAtomCommand(ticketEnvironment.deleteTicket);
  const restore = useAtomCommand(ticketEnvironment.restoreTicket);
  const save = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    const result = await upsert({
      environmentId,
      input: {
        id: ticket.id,
        requireExisting: true,
        ...(edited.title ? { title: title.trim() } : {}),
        ...(edited.body ? { body } : {}),
        ...(edited.project
          ? { projectId: projectId === "none" ? null : ProjectId.make(projectId) }
          : {}),
        ...(pickedStatus ? { status: pickedStatus } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(null);
      setEdited({ title: false, body: false, project: false });
      toastManager.add({ type: "success", title: "Ticket saved" });
    }
  };
  const deleteTicket = async () => {
    setBusy(true);
    const result = await remove({ environmentId, input: { id: ticket.id } });
    setBusy(false);
    if (result._tag !== "Success") return;
    onClose();
    toastManager.add({
      title: "Ticket deleted",
      actionProps: {
        children: "Undo",
        onClick: () => {
          void restore({ environmentId, input: { id: ticket.id } });
        },
      },
    });
  };
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <SheetPopup>
        <SheetHeader>
          <SheetTitle>Ticket</SheetTitle>
          <SheetDescription>Edit this idea and see its linked work.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-3">
          <div className="flex flex-col gap-4">
            <label className="grid gap-1.5">
              <span>Title</span>
              <Input
                aria-label="Ticket title"
                disabled={busy}
                value={edited.title ? title : ticket.title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setEdited((old) => ({ ...old, title: true }));
                }}
              />
            </label>
            <label className="grid gap-1.5">
              <span>Body</span>
              <Textarea
                aria-label="Ticket body"
                disabled={busy}
                value={edited.body ? body : ticket.body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setEdited((old) => ({ ...old, body: true }));
                }}
              />
            </label>
            <TicketPicker
              label="Project"
              disabled={busy}
              value={
                edited.project
                  ? projectId
                  : projects.some((p) => p.id === ticket.projectId)
                    ? ticket.projectId!
                    : "none"
              }
              options={[
                { value: "none", label: "No project" },
                ...projects.map((p) => ({ value: p.id, label: p.title })),
              ]}
              onChange={(value) => {
                setProjectId(value);
                setEdited((old) => ({ ...old, project: true }));
              }}
            />
            <TicketPicker
              label="Status"
              disabled={busy}
              value={pickedStatus ?? status}
              options={Object.entries(TICKET_STATUS_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(value) => setStatus(value as TicketStatus)}
            />
            <Button
              disabled={!canWrite || busy || !title.trim()}
              onClick={() => {
                void save();
              }}
            >
              Save changes
            </Button>
            <TicketStartWork entry={entry} />
            <h3 className="text-sm font-medium">Linked threads</h3>
            <TicketLinks entry={entry} editable />
            {ticket.links.length === 0 ? (
              <p className="text-sm text-muted-foreground">No linked threads yet.</p>
            ) : null}
          </div>
        </div>
        <div className="flex justify-end p-6">
          <Button
            variant="destructive"
            disabled={!canWrite || busy}
            onClick={() => {
              void deleteTicket();
            }}
          >
            Delete ticket
          </Button>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
