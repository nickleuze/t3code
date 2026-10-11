import { useTicketWriteAllowed } from "../../state/tickets";
import { randomUUID } from "../../lib/utils";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  ProjectId,
  type ModelSelection,
  type ProviderInstanceId,
  type Ticket,
} from "@t3tools/contracts";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { ticketStartPrompt } from "@t3tools/shared/ticket";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useComposerDraftStore } from "../../composerDraftStore";
import { setPendingTicketDraft } from "../../pendingTicketDrafts";
import { useProjects, useServerConfigs } from "../../state/entities";
import { ticketEnvironment } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { TicketPicker } from "./TicketPicker";

type StartMode = "draft" | "launch" | "plan" | "goal";
export function TicketStartWork({ entry }: { entry: EnvironmentTicket }) {
  const { environmentId, ticket } = entry;
  const canWrite = useTicketWriteAllowed(environmentId);
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const project = projects.find((p) => p.id === ticket.projectId);
  const [mode, setMode] = useState<StartMode | null>(null);
  const [busy, setBusy] = useState(false);
  const newThread = useNewThreadHandler();
  const startDraft = async (target: Ticket, goal: boolean) => {
    if (!target.projectId) return;
    setBusy(true);
    try {
      const opened = await newThread(scopeProjectRef(environmentId, target.projectId), {
        envMode: "worktree",
      });
      if (!opened) return;
      useComposerDraftStore
        .getState()
        .setPrompt(
          opened.draftId,
          `${goal ? "Make this a T3 goal: " : ""}${ticketStartPrompt(target)}`,
        );
      useComposerDraftStore.getState().setDraftThreadContext(opened.draftId, {
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      });
      setPendingTicketDraft(opened.draftId, {
        environmentId,
        ticketId: target.id,
        threadId: opened.threadId,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open draft",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  const start = (next: StartMode) => {
    if (busy || !canWrite) return;
    if (project && (next === "draft" || next === "goal")) {
      void startDraft(ticket, next === "goal");
      return;
    }
    setMode(next);
  };
  return (
    <>
      <div className="flex items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !canWrite}
          onClick={() => start("draft")}
        >
          Start work
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Start work options"
                disabled={busy || !canWrite}
              />
            }
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup>
            <MenuItem onClick={() => start("draft")}>Draft</MenuItem>
            <MenuItem onClick={() => start("launch")}>Launch now</MenuItem>
            <MenuItem onClick={() => start("plan")}>Plan first</MenuItem>
            <MenuItem onClick={() => start("goal")}>As goal</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {mode ? (
        <TicketStartDialog
          entry={entry}
          mode={mode}
          onClose={() => setMode(null)}
          onDraft={async (target) => {
            setMode(null);
            await startDraft(target, mode === "goal");
          }}
        />
      ) : null}
    </>
  );
}
function TicketStartDialog({
  entry,
  mode,
  onClose,
  onDraft,
}: {
  entry: EnvironmentTicket;
  mode: StartMode;
  onClose: () => void;
  onDraft: (ticket: Ticket) => Promise<void>;
}) {
  const { environmentId, ticket } = entry;
  const canWrite = useTicketWriteAllowed(environmentId);
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const [projectId, setProjectId] = useState<string>(
    projects.find((p) => p.id === ticket.projectId)?.id ?? projects[0]?.id ?? "none",
  );
  const project = projects.find((p) => p.id === projectId) ?? null;
  const config = useServerConfigs().get(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(config?.providers ?? []),
    settings,
  );
  const available = entries.filter(
    (e) =>
      e.enabled && e.installed && e.isAvailable && e.snapshot.auth.status !== "unauthenticated",
  );
  const claude = available.find((e) => e.driverKind === "claudeAgent");
  const claudeModel =
    claude?.models.find((m) => m.isDefault) ?? claude?.models.find((m) => !m.isLegacy);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const selection =
    picked ??
    (mode === "plan" && claude && claudeModel
      ? { instanceId: claude.instanceId, model: claudeModel.slug }
      : scheduledTaskDefaultModel(settings, project, entries));
  const [workspace, setWorkspace] = useState("worktree");
  const [baseRef, setBaseRef] = useState("");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [launchedThread, setLaunchedThread] = useState<
    import("@t3tools/contracts").ThreadId | null
  >(null);
  const upsert = useAtomCommand(ticketEnvironment.upsertTicket);
  const launch = useOrchestrationCommand(ticketEnvironment.launchTicketThread);
  const link = useAtomCommand(ticketEnvironment.linkTicket);
  const navigate = useNavigate();
  const isDraft = mode === "draft" || mode === "goal";
  const submit = async () => {
    if (!canWrite || !project || submitting.current || (!isDraft && !selection)) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      let target = ticket;
      if (ticket.projectId !== project.id) {
        const patched = await upsert({
          environmentId,
          input: { id: ticket.id, requireExisting: true, projectId: ProjectId.make(project.id) },
        });
        if (patched._tag !== "Success") {
          setError("Could not assign the project.");
          return;
        }
        target = patched.value.ticket;
      }
      if (isDraft) {
        await onDraft(target);
        return;
      }
      let threadId = launchedThread;
      if (!threadId) {
        const result = await launch({
          environmentId,
          input: {
            commandId: CommandId.make(randomUUID()),
            projectId: project.id,
            title: target.title,
            modelSelection: selection!,
            runtimeMode: "approval-required",
            interactionMode: mode === "plan" ? "plan" : "default",
            workspaceStrategy:
              workspace === "worktree"
                ? { type: "worktree", baseRef: baseRef.trim() || "HEAD" }
                : { type: "root" },
            initialMessage: { text: ticketStartPrompt(target), attachments: [] },
            creationSource: "web",
          },
        });
        if (result._tag !== "Success") {
          setError("Could not launch the thread. Check the connection before trying again.");
          return;
        }
        threadId = result.value.threadId;
        setLaunchedThread(threadId);
      }
      const linked = await link({
        environmentId,
        input: { id: ticket.id, threadId, role: "work" },
      });
      if (linked._tag !== "Success") {
        setError("Thread launched; linking failed. Retry links the same thread.");
        return;
      }
      onClose();
      await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {isDraft ? "Choose a project" : mode === "plan" ? "Plan first" : "Launch now"}
          </DialogTitle>
          <DialogDescription>{ticket.title}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <TicketPicker
            label="Project"
            value={projectId}
            options={projects.map((p) => ({ value: p.id, label: p.title }))}
            onChange={setProjectId}
            disabled={pending || !!launchedThread}
          />
          {!isDraft ? (
            <>
              {selection ? (
                <ProviderModelPicker
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={
                    new Map(
                      entries.map((e) => [
                        e.instanceId,
                        getAppModelOptionsForInstance(settings, e),
                      ]),
                    )
                  }
                  onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
                    setPicked({ instanceId, model })
                  }
                  isComposerOwned={false}
                  disabled={pending || !!launchedThread}
                  triggerAriaLabel="Model"
                />
              ) : (
                <p>No available model. Configure a provider in Settings.</p>
              )}
              <TicketPicker
                label="Workspace"
                value={workspace}
                options={[
                  { value: "worktree", label: "Worktree" },
                  { value: "local", label: "Local" },
                ]}
                onChange={setWorkspace}
                disabled={pending || !!launchedThread}
              />
              {workspace === "worktree" ? (
                <label className="grid gap-1.5">
                  <span>Base branch (optional)</span>
                  <Input
                    aria-label="Base branch"
                    placeholder="Current branch"
                    value={baseRef}
                    onChange={(e) => setBaseRef(e.target.value)}
                    disabled={pending || !!launchedThread}
                  />
                </label>
              ) : null}
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={pending || !canWrite || !project || (!isDraft && !selection)}
            onClick={() => {
              void submit();
            }}
          >
            {launchedThread ? "Retry link" : isDraft ? "Open draft" : "Launch"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
