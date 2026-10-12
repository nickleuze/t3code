import { threadEnvironment } from "../../state/threads";
import { resumeTicketLinks } from "./ticketRecord.logic";
import { useTicketConnections } from "./useTicketConnections";
import { useTicketWriteAllowed } from "../../state/tickets";
import { randomUUID } from "../../lib/utils";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadLaunchInput,
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
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { ticketEnvironment } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { launchLinkedTicketThread } from "./ticketLaunch";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { useMediaQuery } from "../../hooks/useMediaQuery";
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
  const { machine } = useTicketConnections(entry);
  const navigate = useNavigate();
  const canWrite = useTicketWriteAllowed(environmentId);
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
  const branches = ticket.links
    .filter((link) => link.role !== "origin")
    .flatMap(
      (link) =>
        shells.find((shell) => shell.environmentId === environmentId && shell.id === link.threadId)
          ?.source.branch ?? [],
    );
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const project = projects.find((p) => p.id === ticket.projectId);
  const [mode, setMode] = useState<StartMode | null>(null);
  const [busy, setBusy] = useState(false);
  const newThread = useNewThreadHandler();
  const startDraft = async (target: Ticket) => {
    if (!target.projectId) return;
    setBusy(true);
    try {
      const opened = await newThread(scopeProjectRef(environmentId, target.projectId), {
        envMode: "worktree",
      });
      if (!opened) return;
      useComposerDraftStore
        .getState()
        .setPrompt(opened.draftId, ticketStartPrompt(target, branches));
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
  const narrow = useMediaQuery("(max-width: 480px)");
  const start = (next: StartMode) => {
    if (busy || !canWrite) return;
    if (project && next === "draft") {
      void startDraft(ticket);
      return;
    }
    setMode(next);
  };
  return (
    <>
      <div className="flex items-center gap-1">
        <Button
          size={narrow ? "touch" : "xs"}
          variant="outline"
          disabled={busy || !canWrite}
          onClick={() => {
            const link = resumable[0];
            if (link)
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: link.threadId },
              });
            else start("draft");
          }}
        >
          {resumable.length ? "Resume" : "Start work"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size={narrow ? "icon-touch" : "icon-xs"}
                variant="outline"
                aria-label="Start work options"
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
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: link.threadId },
                  })
                }
              >
                Resume{" "}
                {link.title ??
                  shells.find((s) => s.id === link.threadId && s.environmentId === environmentId)
                    ?.title ??
                  link.threadId}
              </MenuItem>
            ))}
            <MenuItem density={narrow ? "phone" : "default"} onClick={() => start("draft")}>
              Draft
            </MenuItem>
            <MenuItem density={narrow ? "phone" : "default"} onClick={() => start("launch")}>
              Launch now
            </MenuItem>
            <MenuItem density={narrow ? "phone" : "default"} onClick={() => start("plan")}>
              Plan first
            </MenuItem>
            <MenuItem density={narrow ? "phone" : "default"} onClick={() => start("goal")}>
              As goal
            </MenuItem>
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
            await startDraft(target);
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
  const narrow = useMediaQuery("(max-width: 480px)");
  const { environmentId, ticket } = entry;
  const canWrite = useTicketWriteAllowed(environmentId);
  const shells = useThreadShells();
  const branches = ticket.links
    .filter((link) => link.role !== "origin")
    .flatMap(
      (link) =>
        shells.find((shell) => shell.environmentId === environmentId && shell.id === link.threadId)
          ?.source.branch ?? [],
    );
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
  const ambiguousLaunch = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [launchIds] = useState(() => ({
    threadId: ThreadId.make(randomUUID()),
    commandId: CommandId.make(randomUUID()),
  }));
  const [launchInput, setLaunchInput] = useState<
    (OrchestrationV2ThreadLaunchInput & { threadId: ThreadId }) | null
  >(null);
  const [goalObjective, setGoalObjective] = useState<string | null>(null);
  const defaultRuntimeMode = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultRuntimeMode;
  const supportedModes = entries.find((e) => e.instanceId === selection?.instanceId)?.snapshot
    .supportedRuntimeModes;
  const compatibleModes = supportedModes?.length
    ? runtimeModeOptions.filter((mode) => supportedModes.includes(mode))
    : runtimeModeOptions;
  const runtimeMode = compatibleModes.includes(defaultRuntimeMode)
    ? defaultRuntimeMode
    : (compatibleModes[0] ?? defaultRuntimeMode);
  const upsert = useAtomCommand(ticketEnvironment.upsertTicket);
  const map = useAtomCommand(ticketEnvironment.projectsMap);
  const launch = useOrchestrationCommand(ticketEnvironment.launchTicketThread);
  const link = useAtomCommand(ticketEnvironment.linkTicket);
  const unlink = useAtomCommand(ticketEnvironment.unlinkTicket);
  const navigate = useNavigate();
  const setGoal = useAtomCommand(threadEnvironment.setGoal);
  const isDraft = mode === "draft";
  const submit = async () => {
    if (!canWrite || !project || submitting.current || (!isDraft && !selection)) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      let target = ticket;
      if (ticket.projectKey && ticket.projectId !== project.id) {
        const mapped = await map({
          environmentId,
          input: {
            key: ticket.projectKey,
            projectId: ProjectId.make(project.id),
            displayName: ticket.projectName ?? ticket.projectKey,
          },
        });
        if (mapped._tag !== "Success") {
          setError("Could not map the project.");
          return;
        }
        target = { ...ticket, projectId: ProjectId.make(project.id) };
      } else if (ticket.projectId !== project.id) {
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
      // Freeze the entire request after the first submit, including prompt and
      // model defaults that may change while an ambiguous response is retried.
      const input = launchInput ?? {
        ...launchIds,
        projectId: project.id,
        title: target.title,
        modelSelection: selection!,
        runtimeMode,
        interactionMode: mode === "plan" ? ("plan" as const) : ("default" as const),
        workspaceStrategy:
          workspace === "worktree"
            ? { type: "worktree" as const, baseRef: baseRef.trim() || "HEAD" }
            : { type: "root" as const },
        ...(mode === "goal"
          ? {}
          : { initialMessage: { text: ticketStartPrompt(target, branches), attachments: [] } }),
        creationSource: "web" as const,
      };
      setLaunchInput(input);
      const objective = goalObjective ?? ticketStartPrompt(target, branches);
      if (mode === "goal") setGoalObjective(objective);
      const attempt = await launchLinkedTicketThread({
        environmentId,
        ticketId: ticket.id,
        input,
        link,
        launch,
        unlink,
        unlinkOnRejection: !ambiguousLaunch.current,
      });
      if (attempt.step !== "launch" || attempt.result._tag !== "Success") {
        if (attempt.step === "launch" && !attempt.rejected) ambiguousLaunch.current = true;
        setError(
          attempt.step === "link"
            ? "Could not link the ticket. Retry uses the same thread."
            : "Launch was not confirmed. Retry safely resumes the same thread.",
        );
        return;
      }
      const threadId = input.threadId;
      if (mode === "goal") {
        const goal = await setGoal({
          environmentId,
          input: {
            type: "thread.goal.set",
            threadId,
            commandId: CommandId.make(`ticket-goal:${input.commandId}`),
            objective,
          },
        });
        if (goal._tag !== "Success") {
          setError("Goal start was not confirmed. Retry uses the same goal and thread.");
          return;
        }
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
      <DialogPopup variant="mobile-fullscreen">
        <DialogHeader>
          <DialogTitle>
            {isDraft
              ? "Choose a project"
              : mode === "plan"
                ? "Plan first"
                : mode === "goal"
                  ? "As goal"
                  : "Launch now"}
          </DialogTitle>
          <DialogDescription>{ticket.title}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <TicketPicker
            label="Project"
            value={projectId}
            options={projects.map((p) => ({ value: p.id, label: p.title }))}
            onChange={setProjectId}
            disabled={pending || !!launchInput}
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
                  disabled={pending || !!launchInput}
                  triggerAriaLabel="Model"
                />
              ) : (
                <p>No available model. Configure a provider in Settings.</p>
              )}
              <p className="text-sm text-muted-foreground">
                Runtime mode: {runtimeModeConfig[launchInput?.runtimeMode ?? runtimeMode].label}
              </p>
              <TicketPicker
                label="Workspace"
                value={workspace}
                options={[
                  { value: "worktree", label: "Worktree" },
                  { value: "local", label: "Local" },
                ]}
                onChange={setWorkspace}
                disabled={pending || !!launchInput}
              />
              {workspace === "worktree" ? (
                <label className="grid gap-1.5">
                  <span>Base branch (optional)</span>
                  <Input
                    size={narrow ? "touch" : "default"}
                    aria-label="Base branch"
                    placeholder="Current branch"
                    value={baseRef}
                    onChange={(e) => setBaseRef(e.target.value)}
                    disabled={pending || !!launchInput}
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
          <Button
            size={narrow ? "touch" : "default"}
            variant="outline"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size={narrow ? "touch" : "default"}
            disabled={pending || !canWrite || !project || (!isDraft && !selection)}
            onClick={() => {
              void submit();
            }}
          >
            {isDraft ? "Open draft" : error ? "Retry" : "Launch"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
