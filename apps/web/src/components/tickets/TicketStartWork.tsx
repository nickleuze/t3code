import {
  CommandId,
  ProjectId,
  ThreadId,
  type EnvironmentId,
  type TicketStartInput,
  type TicketStartMode,
} from "@t3tools/contracts";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { ticketEnvironment, useTicketWriteAllowed } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { resumeTicketLinks } from "./ticketRecord.logic";
import { useTicketConnections } from "./useTicketConnections";

export function TicketStartWork({ entry }: { entry: EnvironmentTicket }) {
  const { environmentId, ticket } = entry;
  const { machine } = useTicketConnections(entry);
  const navigate = useNavigate();
  const canWrite = useTicketWriteAllowed(environmentId);
  const narrow = useMediaQuery("(max-width: 480px)");
  const shells = useThreadShells();
  const resumable = resumeTicketLinks(
    ticket.links,
    machine,
    new Set(
      shells
        .filter(
          (s) => s.environmentId === environmentId && s.deletedAt === null && s.archivedAt === null,
        )
        .map((s) => s.id),
    ),
  );
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const project = projects.find((p) => p.id === ticket.projectId);
  const [pickerMode, setPickerMode] = useState<TicketStartMode | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const pending = useRef<{ environmentId: EnvironmentId; input: TicketStartInput } | null>(null);
  const startTicket = useAtomCommand(ticketEnvironment.startTicket, { reportFailure: false });
  const open = (targetEnvironmentId: EnvironmentId, threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: targetEnvironmentId, threadId },
    });
  // Target is explicit so the other-machine entry point can use the same call.
  const launch = async (
    targetEnvironmentId: EnvironmentId,
    mode: TicketStartMode,
    projectId?: ProjectId,
  ) => {
    if (!canWrite || submitting.current) return;
    const request = pending.current ?? {
      environmentId: targetEnvironmentId,
      input: {
        ticketId: ticket.id,
        threadId: ThreadId.make(randomUUID()),
        commandId: CommandId.make(randomUUID()),
        mode,
        ...(projectId ? { projectId } : {}),
        creationSource: "web" as const,
      },
    };
    pending.current = request;
    submitting.current = true;
    setBusy(true);
    setPickerMode(null);
    try {
      const result = await startTicket(request);
      if (result._tag === "Success") {
        pending.current = null;
        const toastId = toastManager.add({
          type: "success",
          title:
            result.value.status === "already_active"
              ? `Already active: ${ticket.title}`
              : `Launched ${ticket.title}`,
          actionProps: {
            children: "Open",
            onClick: () => {
              toastManager.close(toastId);
              open(request.environmentId, result.value.threadId);
            },
          },
        });
      } else {
        const error = squashAtomCommandFailure(result);
        if (
          error &&
          typeof error === "object" &&
          "_tag" in error &&
          error._tag === "TicketLaunchNeedsProject"
        ) {
          pending.current = null;
          setPickerMode(mode);
          return;
        }
        const toastId = toastManager.add({
          type: "error",
          title: "Launch was not confirmed",
          description: "Retry safely uses the same thread and command.",
          actionProps: {
            children: "Retry",
            onClick: () => {
              toastManager.close(toastId);
              void launch(
                request.environmentId,
                request.input.mode ?? "plan",
                request.input.projectId,
              );
            },
          },
        });
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const start = (mode: TicketStartMode) => {
    if (busy || !canWrite) return;
    if (pending.current || project) void launch(environmentId, mode);
    else setPickerMode(mode);
  };
  return (
    <div className="flex items-center gap-1">
      <Popover
        open={pickerMode !== null}
        onOpenChange={(value) => {
          if (!value) setPickerMode(null);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              size={narrow ? "touch" : "xs"}
              variant="outline"
              disabled={busy || !canWrite}
              onClick={() => {
                if (resumable[0]) open(environmentId, resumable[0].threadId);
                else start("plan");
              }}
            />
          }
        >
          {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
          {resumable.length ? "Resume" : "Launch"}
        </PopoverTrigger>
        <PopoverPopup width="sm" align="start">
          <div className="grid gap-2">
            <p className="text-sm font-medium">Choose a project</p>
            {projects.length ? (
              projects.map((p) => (
                <Button
                  key={p.id}
                  size={narrow ? "touch" : "default"}
                  variant="outline"
                  onClick={() => void launch(environmentId, pickerMode ?? "plan", p.id)}
                >
                  {p.title}
                </Button>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Add a project to this machine first.</p>
            )}
          </div>
        </PopoverPopup>
      </Popover>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size={narrow ? "icon-touch" : "icon-xs"}
              variant="outline"
              aria-label="Launch options"
              disabled={busy || !canWrite}
            />
          }
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup>
          {resumable.map((link) => (
            <MenuItem
              key={link.threadId}
              density={narrow ? "phone" : "default"}
              onClick={() => open(environmentId, link.threadId)}
            >
              Resume{" "}
              {link.title ??
                shells.find((s) => s.id === link.threadId && s.environmentId === environmentId)
                  ?.title ??
                link.threadId}
            </MenuItem>
          ))}
          <MenuItem density={narrow ? "phone" : "default"} onClick={() => start("default")}>
            Launch without planning
          </MenuItem>
          <MenuItem density={narrow ? "phone" : "default"} onClick={() => start("goal")}>
            Launch as goal
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
