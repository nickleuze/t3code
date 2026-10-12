import { useTicketWriteAllowed } from "../../state/tickets";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useSearch } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, type TicketId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useTicketCapture } from "../../ticketCapture";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { ticketEnvironment, ticketEnvironmentIdsAtom } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { TicketPicker } from "./TicketPicker";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { resolveSettingsScope } from "../settings/settingsScope";
import { usePendingTicketDrafts, linkPromotedTicketDraft } from "../../pendingTicketDrafts";
import { useThreadShells } from "../../state/entities";

import { useTicketLaunch } from "./useTicketLaunch";

export function TicketCaptureHost() {
  const request = useTicketCapture((state) => state.request);
  const environmentIds = useAtomValue(ticketEnvironmentIdsAtom);
  const pending = usePendingTicketDrafts((state) => state.links);
  const shells = useThreadShells(Object.keys(pending).length > 0);
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    for (const [draftId, link] of Object.entries(pending)) {
      if (
        !attempted.current.has(draftId) &&
        shells.some(
          (shell) =>
            shell.environmentId === link.environmentId &&
            shell.id === link.threadId &&
            shell.latestUserMessageAt !== null,
        )
      ) {
        attempted.current.add(draftId);
        void linkPromotedTicketDraft(draftId, {
          environmentId: link.environmentId,
          threadId: link.threadId,
        });
      }
    }
  }, [pending, shells]);
  return request && environmentIds.length > 0 ? (
    <TicketCaptureDialog key={JSON.stringify(request)} />
  ) : null;
}
function TicketCaptureDialog() {
  const narrow = useMediaQuery("(max-width: 480px)");
  const request = useTicketCapture((state) => state.request)!;
  const environmentIds = useAtomValue(ticketEnvironmentIdsAtom);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const routeSearch = useSearch({ strict: false });
  const projectGroups = useSettingsProjectGroups();
  const settingsScope = resolveSettingsScope(routeSearch, projectGroups, environments);
  const routeProject = routeSearch.project
    ? settingsScope.members.find((p) => environmentIds.includes(p.environmentId))
    : projects.find(
        (p) =>
          p.id === routeSearch.projectId &&
          p.environmentId === (routeSearch.projectEnvironmentId ?? routeSearch.environmentId),
      );
  const { activeThread, activeDraftThread } = useHandleNewThread();
  const current = activeThread ?? activeDraftThread;
  const [lastUsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("t3-ticket-last-project") ?? "null") as {
        environmentId: string;
        projectId: string | null;
      } | null;
    } catch {
      return null;
    }
  });
  const preferred =
    request.projectRef ??
    (current
      ? scopeProjectRef(current.environmentId, current.projectId)
      : routeProject
        ? scopeProjectRef(routeProject.environmentId, routeProject.id)
        : lastUsed);
  const [environmentId, setEnvironmentId] = useState(
    environmentIds.find((id) => id === preferred?.environmentId) ?? environmentIds[0]!,
  );
  const canWrite = useTicketWriteAllowed(environmentId);
  const [projectId, setProjectId] = useState<string>(
    projects.some((p) => p.environmentId === environmentId && p.id === preferred?.projectId)
      ? preferred!.projectId!
      : "none",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [savedId, setSavedId] = useState<TicketId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const upsert = useAtomCommand(ticketEnvironment.upsertTicket);
  const link = useAtomCommand(ticketEnvironment.linkTicket);
  const { launch } = useTicketLaunch();
  const close = () => useTicketCapture.setState({ request: null });
  const save = async (another: boolean, launchWork = false) => {
    if (!canWrite || !title.trim() || submitting.current || (launchWork && projectId === "none"))
      return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await upsert({
        environmentId,
        input: {
          ...(savedId ? { id: savedId, requireExisting: true } : {}),
          title: title.trim(),
          body,
          projectId: projectId === "none" ? null : ProjectId.make(projectId),
          creationSource: "web",
          ...(request.origin && request.origin.environmentId === environmentId
            ? { originThreadId: request.origin.threadId }
            : {}),
        },
      });
      if (result._tag !== "Success") {
        setError("Could not save the ticket. Your text is still here.");
        return;
      }
      setSavedId(result.value.ticket.id);
      if (request.origin && request.origin.environmentId === environmentId) {
        const linked = await link({
          environmentId,
          input: { id: result.value.ticket.id, threadId: request.origin.threadId, role: "origin" },
        });
        if (linked._tag !== "Success") {
          setError("Ticket saved; the origin link failed. Link it from the thread details.");
          return;
        }
      }
      localStorage.setItem(
        "t3-ticket-last-project",
        JSON.stringify({ environmentId, projectId: projectId === "none" ? null : projectId }),
      );
      if (launchWork) {
        close();
        await launch({
          environmentId,
          ticketId: result.value.ticket.id,
          title: result.value.ticket.title,
          mode: "plan",
          created: true,
        });
      } else if (another) {
        setSavedId(null);
        setTitle("");
        setBody("");
        input.current?.focus();
      } else close();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup variant="mobile-fullscreen" initialFocus={input}>
        <form
          className={narrow ? "contents" : undefined}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "Enter") {
              event.preventDefault();
              void save(false, true);
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>New ticket</DialogTitle>
            <DialogDescription>Capture an idea to work on later.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="grid gap-1.5">
              <span>Title</span>
              <Input
                size={narrow ? "touch" : "default"}
                ref={input}
                autoFocus
                aria-label="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="grid gap-1.5">
              <span>Body (optional)</span>
              <Textarea
                aria-label="Body (optional)"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            {environmentIds.length > 1 ? (
              <TicketPicker
                label="Environment"
                value={environmentId}
                options={environmentIds.map((id) => ({
                  value: id,
                  label: environments.find((e) => e.environmentId === id)?.label ?? id,
                }))}
                onChange={(value) => {
                  setEnvironmentId(EnvironmentId.make(value));
                  setProjectId("none");
                }}
                disabled={busy || !!request.origin}
              />
            ) : null}
            <TicketPicker
              label="Project"
              value={projectId}
              options={[
                { value: "none", label: "No project" },
                ...projects
                  .filter((p) => p.environmentId === environmentId)
                  .map((p) => ({ value: p.id, label: p.title })),
              ]}
              onChange={setProjectId}
              disabled={busy || !canWrite}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              size={narrow ? "touch" : "default"}
              variant="outline"
              type="button"
              disabled={busy || !canWrite || !title.trim() || projectId === "none"}
              onClick={() => void save(false, true)}
            >
              Create &amp; launch
            </Button>
            <Button
              size={narrow ? "touch" : "default"}
              variant="outline"
              type="button"
              disabled={busy || !canWrite}
              onClick={() => {
                void save(true);
              }}
            >
              Save &amp; add another
            </Button>
            <Button
              size={narrow ? "touch" : "default"}
              type="submit"
              disabled={busy || !canWrite || !title.trim()}
            >
              Save ticket
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
