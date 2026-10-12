import type { EnvironmentId, TicketId, TicketStartMode, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ticketEnvironment } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  startTicketWithRefresh,
  ticketLaunchFailureTag,
  ticketLaunchRequest,
  type TicketLaunchRequest,
} from "./ticketStart.logic";

type LaunchTarget = {
  environmentId: EnvironmentId;
  label?: string;
  ticketId: TicketId;
  title: string;
  mode: TicketStartMode;
  projectId?: ProjectId;
  created?: boolean;
};

export function useTicketLaunch(onNeedsProject?: (request: TicketLaunchRequest) => void) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const pending = useRef<TicketLaunchRequest | null>(null);
  const startTicket = useAtomCommand(ticketEnvironment.startTicket, { reportFailure: false });
  const refresh = useAtomCommand(ticketEnvironment.syncRefresh, { reportFailure: false });
  const launch = async (target: LaunchTarget, retry?: TicketLaunchRequest) => {
    if (submitting.current) return;
    const request =
      retry ??
      ticketLaunchRequest(
        pending.current,
        target.environmentId,
        target.ticketId,
        target.mode,
        target.projectId,
      );
    pending.current = request;
    submitting.current = true;
    setBusy(true);
    try {
      const result = await startTicketWithRefresh(request, startTicket, () =>
        refresh({ environmentId: request.environmentId, input: {} }),
      );
      if (result._tag === "Success") {
        pending.current = null;
        const toastId = toastManager.add({
          type: "success",
          title:
            result.value.status === "already_active"
              ? `Already active: ${target.title}`
              : `Launched ${target.title}`,
          actionProps: {
            children: "Open",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: request.environmentId, threadId: result.value.threadId },
              });
            },
          },
        });
        return;
      }
      const tag = ticketLaunchFailureTag(result);
      if (tag === "TicketLaunchNeedsProject" && onNeedsProject) {
        pending.current = null;
        onNeedsProject(request);
        return;
      }
      if (tag === "TicketNotFound") pending.current = null;
      const toastId = toastManager.add({
        type: "error",
        title: target.created
          ? "Ticket created but not launched"
          : tag === "TicketNotFound"
            ? `Not synced to ${target.label ?? "this machine"} yet`
            : "Launch was not confirmed",
        description: "Retry safely uses the same thread and command.",
        actionProps: {
          children: "Retry",
          onClick: () => {
            toastManager.close(toastId);
            void launch(target, request);
          },
        },
      });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return { busy, launch };
}
