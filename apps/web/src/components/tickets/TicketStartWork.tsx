import type { EnvironmentId, TicketStartMode, ThreadId } from "@t3tools/contracts";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { useTicketWriteAllowed } from "../../state/tickets";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { resumeTicketLinks } from "./ticketRecord.logic";
import { useTicketConnections } from "./useTicketConnections";

import { useTicketLaunch } from "./useTicketLaunch";
import type { TicketLaunchRequest } from "./ticketStart.logic";

export function TicketStartWork({ entry }: { entry: EnvironmentTicket }) {
  const { environmentId, ticket } = entry;
  const { machine, machines } = useTicketConnections(entry);
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
  const allProjects = useProjects();
  const [picker, setPicker] = useState<TicketLaunchRequest | null>(null);
  const { busy, launch } = useTicketLaunch(setPicker);
  const projects = allProjects.filter(
    (p) => p.environmentId === (picker?.environmentId ?? environmentId),
  );
  const open = (targetEnvironmentId: EnvironmentId, threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: targetEnvironmentId, threadId },
    });
  const start = (mode: TicketStartMode, targetEnvironmentId = environmentId, label?: string) => {
    if (busy) return;
    setPicker(null);
    void launch({
      environmentId: targetEnvironmentId,
      ...(label ? { label } : {}),
      ticketId: ticket.id,
      title: ticket.title,
      mode,
    });
  };
  return (
    <div className="flex items-center gap-1">
      <Popover
        open={picker !== null}
        onOpenChange={(value) => {
          if (!value) setPicker(null);
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
                  onClick={() => {
                    if (!picker) return;
                    const request = picker;
                    setPicker(null);
                    void launch({
                      environmentId: request.environmentId,
                      label:
                        [...machines.values()].find(
                          (target) => target.environmentId === request.environmentId,
                        )?.label ?? "this machine",
                      ticketId: ticket.id,
                      title: ticket.title,
                      mode: request.input.mode ?? "plan",
                      projectId: p.id,
                    });
                  }}
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
              disabled={busy}
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
          <MenuItem
            disabled={!canWrite}
            density={narrow ? "phone" : "default"}
            onClick={() => start("default")}
          >
            Launch without planning
          </MenuItem>
          <MenuItem
            disabled={!canWrite}
            density={narrow ? "phone" : "default"}
            onClick={() => start("goal")}
          >
            Launch as goal
          </MenuItem>
          {[...machines.values()]
            .filter((target) => target.environmentId !== environmentId)
            .map((target) => (
              <RemoteLaunchItem
                key={target.environmentId}
                target={target}
                busy={busy}
                narrow={narrow}
                onLaunch={() => start("plan", target.environmentId, target.label)}
              />
            ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}

function RemoteLaunchItem({
  target,
  busy,
  narrow,
  onLaunch,
}: {
  target: { environmentId: EnvironmentId; label: string };
  busy: boolean;
  narrow: boolean;
  onLaunch: () => void;
}) {
  const canWrite = useTicketWriteAllowed(target.environmentId);
  return (
    <MenuItem
      disabled={busy || !canWrite}
      density={narrow ? "phone" : "default"}
      onClick={onLaunch}
    >
      Launch on {target.label}
    </MenuItem>
  );
}
