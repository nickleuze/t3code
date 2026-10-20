import { openWorkModelProject } from "../../workModelProject";
import { useTicketWriteAllowed } from "../../state/tickets";
import { ProjectId, type TicketStatus } from "@t3tools/contracts";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { TICKET_STATUS_LABELS } from "@t3tools/client-runtime/state/ticket-board";
import { deriveTicketStatus } from "@t3tools/shared/ticket";
import { useRef, useState } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { ticketEnvironment } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Sheet, SheetPopup, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet";
import { toastManager } from "../ui/toast";
import { TicketPicker } from "./TicketPicker";
import { TicketActions } from "./TicketActions";
import { Badge } from "../ui/badge";
import { useTicketConnections } from "./useTicketConnections";
import { ticketActivity } from "./ticketRecord.logic";

import { TicketTimeline } from "./TicketTimeline";
import { TicketStartWork } from "./TicketStartWork";

export function TicketDetail({
  entry,
  onClose,
}: {
  entry: EnvironmentTicket;
  onClose: () => void;
}) {
  const { ticket, environmentId } = entry;
  const { linked } = useTicketConnections(entry);
  const activity = ticketActivity(
    ticket,
    linked.filter((l) => l.link.role !== "origin").map((l) => l.thread.source),
  );
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
  const narrow = useMediaQuery("(max-width: 480px)");
  const [busy, setBusy] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const readableId = ticket.readableId ?? ticket.id;
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "Ticket ID",
    onError: () => toastManager.add({ type: "error", title: "Could not copy Ticket ID" }),
  });
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
      <SheetPopup variant="wide">
        <SheetHeader>
          <div className="flex min-w-0 items-center gap-2 pr-8">
            <span className="min-w-0 text-xs font-mono wrap-anywhere">{readableId}</span>
            <Button
              size={narrow ? "touch" : "xs"}
              variant="ghost"
              aria-label="Copy Ticket ID"
              onClick={() => copyToClipboard(readableId)}
            >
              {isCopied ? "Copied" : "Copy ID"}
            </Button>
          </div>
          <SheetTitle>{ticket.title}</SheetTitle>
          <SheetDescription>
            {ticket.projectName ?? ticket.projectKey ?? "No project"} ·{" "}
            {[
              ...new Set(ticket.links.map((l) => l.machineLabel ?? l.machine).filter(Boolean)),
            ].join(", ") || "Local record"}
          </SheetDescription>
          <div className="flex flex-wrap items-center gap-2">
            <TicketActions entry={entry} />
            <Badge
              variant={
                activity === "Blocked"
                  ? "warning"
                  : activity === "Result ready"
                    ? "success"
                    : "info"
              }
            >
              {activity}
            </Badge>
          </div>
          {ticket.status === "inbox" && ticket.deletedAt === null ? (
            <Button
              variant="outline"
              disabled={
                !canWrite || busy || Object.values(edited).some(Boolean) || pickedStatus !== null
              }
              title="Save any edits before creating a Project from this Idea"
              onClick={() => {
                onClose();
                openWorkModelProject({
                  environmentId,
                  sourceIdeaId: ticket.id,
                  name: ticket.title,
                  purpose: ticket.body || ticket.title,
                });
              }}
            >
              New project from Idea
            </Button>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {activity !== "Project origin" ? <TicketStartWork entry={entry} /> : null}
            <Button
              size={narrow ? "touch" : "sm"}
              variant="outline"
              disabled={!canWrite || busy}
              onClick={() => {
                composerRef.current?.scrollIntoView({ block: "center" });
                composerRef.current?.focus({ preventScroll: true });
              }}
            >
              Add entry
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size={narrow ? "touch" : "sm"}
                    variant="ghost"
                    aria-label="More ticket actions"
                    disabled={busy}
                  />
                }
              >
                More
              </MenuTrigger>
              <MenuPopup>
                <MenuItem
                  disabled={!canWrite || busy}
                  onClick={() => {
                    void deleteTicket();
                  }}
                >
                  Delete ticket
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-3">
          <div className="flex flex-col gap-4">
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Edit ticket
              </summary>
              <div className="grid gap-4 py-3">
                <label className="grid gap-1.5">
                  <span>Title</span>
                  <Input
                    size={narrow ? "touch" : "default"}
                    aria-label="Ticket title"
                    disabled={busy || !canWrite}
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
                    disabled={busy || !canWrite}
                    value={edited.body ? body : ticket.body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      setEdited((old) => ({ ...old, body: true }));
                    }}
                  />
                </label>
                <TicketPicker
                  label="Project"
                  disabled={busy || !canWrite}
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
                  disabled={busy || !canWrite}
                  value={pickedStatus ?? status}
                  options={Object.entries(TICKET_STATUS_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(value) => setStatus(value as TicketStatus)}
                />
                <Button
                  size={narrow ? "touch" : "default"}
                  disabled={!canWrite || busy || !title.trim()}
                  onClick={() => {
                    void save();
                  }}
                >
                  Save changes
                </Button>
              </div>
            </details>
            {ticket.projectKey && !ticket.projectId ? (
              <p className="text-sm text-muted-foreground">
                {ticket.projectName ?? ticket.projectKey} · Map a local project to start work.
              </p>
            ) : null}
            <TicketTimeline entry={entry} composerRef={composerRef} />
          </div>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
