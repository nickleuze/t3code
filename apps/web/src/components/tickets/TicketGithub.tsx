import { useAtomValue } from "@effect/atom-react";
import { TicketError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { useEffect, useRef, useState } from "react";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  ticketEnvironment,
  ticketGithubEnvironmentIdsAtom,
  useTicketGithubSupported,
} from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { TicketPicker } from "./TicketPicker";

const isTicketError = Schema.is(TicketError);
function issueError(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  return isTicketError(error)
    ? error.message
    : "Could not complete the GitHub issue action. Check your connection and permissions, then retry.";
}

export function TicketIssueBadge({ entry }: { entry: EnvironmentTicket }) {
  const supported = useTicketGithubSupported(entry.environmentId);
  const issue = entry.ticket.githubIssue;
  return supported && issue ? (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`GitHub issue #${issue.number}, ${issue.state}`}
    >
      <Badge variant="outline">
        #{issue.number} · {issue.state}
      </Badge>
    </a>
  ) : null;
}

export function TicketGithubSection({
  entry,
  unsaved,
}: {
  entry: EnvironmentTicket;
  unsaved: boolean;
}) {
  const { environmentId, ticket } = entry;
  const supported = useTicketGithubSupported(environmentId);
  const projects = useProjects();
  const project = projects.find(
    (p) => p.environmentId === environmentId && p.id === ticket.projectId,
  );
  const canPublish = useAtomValue(ticketEnvironment.publishIssue.permissionAtom(environmentId));
  const canUnlink = useAtomValue(ticketEnvironment.unlinkIssue.permissionAtom(environmentId));
  const publish = useAtomCommand(ticketEnvironment.publishIssue);
  const unlink = useAtomCommand(ticketEnvironment.unlinkIssue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported) return null;
  return (
    <section className="flex flex-col items-start gap-2" aria-label="GitHub issue">
      <h3 className="text-sm font-medium">GitHub</h3>
      {ticket.githubIssue ? (
        <>
          <TicketIssueBadge entry={entry} />
          <Button
            variant="outline"
            size="sm"
            disabled={!canUnlink || busy}
            onClick={() => {
              setError(null);
              setBusy(true);
              void unlink({ environmentId, input: { id: ticket.id } })
                .then((result) => {
                  if (result._tag === "Failure") setError(issueError(result.cause));
                })
                .finally(() => setBusy(false));
            }}
          >
            Unlink issue
          </Button>
        </>
      ) : project?.repositoryIdentity?.provider === "github" ? (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={!canPublish || busy || unsaved}
            onClick={() => {
              setError(null);
              setBusy(true);
              void publish({ environmentId, input: { id: ticket.id } })
                .then((result) => {
                  if (result._tag === "Failure") setError(issueError(result.cause));
                })
                .finally(() => setBusy(false));
            }}
          >
            Publish as issue
          </Button>
          {unsaved ? (
            <p className="text-xs text-muted-foreground">Save your changes before publishing.</p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Choose a project with a GitHub repository to publish an issue.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function TicketGithubBoardActions() {
  const ids = useAtomValue(ticketGithubEnvironmentIdsAtom);
  const projects = useProjects().filter(
    (p) => ids.includes(p.environmentId) && p.repositoryIdentity?.provider === "github",
  );
  const [importOpen, setImportOpen] = useState(false);
  if (ids.length === 0) return null;
  return (
    <>
      {ids.map((environmentId) => (
        <TicketIssueRefresh
          key={environmentId}
          environmentId={environmentId}
          multiple={ids.length > 1}
        />
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={projects.length === 0}
        onClick={() => setImportOpen(true)}
      >
        Import issue…
      </Button>
      {importOpen ? <TicketIssueImport onClose={() => setImportOpen(false)} /> : null}
    </>
  );
}
function TicketIssueRefresh({
  environmentId,
  multiple,
}: {
  environmentId: EnvironmentTicket["environmentId"];
  multiple: boolean;
}) {
  const canRefresh = useAtomValue(ticketEnvironment.refreshIssues.permissionAtom(environmentId));
  const refresh = useAtomCommand(ticketEnvironment.refreshIssues);
  const { environments } = useEnvironments();
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!canRefresh || mounted.current) return;
    mounted.current = true;
    void refresh({ environmentId, input: {} });
  }, [canRefresh, environmentId, refresh]);
  const label = environments.find((e) => e.environmentId === environmentId)?.label ?? environmentId;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!canRefresh || busy}
      onClick={() => {
        setBusy(true);
        void refresh({ environmentId, input: { force: true } })
          .then((result) => {
            if (result._tag === "Failure")
              toastManager.add({ type: "error", title: issueError(result.cause) });
            if (result._tag === "Success")
              toastManager.add({
                type: result.value.failed > 0 ? "warning" : "success",
                title: `Refreshed ${result.value.refreshed} issues${result.value.failed > 0 ? `; ${result.value.failed} could not be refreshed` : ""}`,
              });
          })
          .finally(() => setBusy(false));
      }}
    >
      {multiple ? `Refresh issues · ${label}` : "Refresh issues"}
    </Button>
  );
}
function TicketIssueImport({ onClose }: { onClose: () => void }) {
  const ids = useAtomValue(ticketGithubEnvironmentIdsAtom);
  const projects = useProjects().filter(
    (p) => ids.includes(p.environmentId) && p.repositoryIdentity?.provider === "github",
  );
  const { environments } = useEnvironments();
  const key = (p: (typeof projects)[number]) => JSON.stringify([p.environmentId, p.id]);
  const [selected, setSelected] = useState(projects[0] ? key(projects[0]) : "");
  const project = projects.find((p) => key(p) === selected);
  const canImport = useAtomValue(
    ticketEnvironment.importIssue.permissionAtom(project?.environmentId ?? null),
  );
  const importIssue = useAtomCommand(ticketEnvironment.importIssue);
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!project || !canImport || !issue.trim() || submitting.current) return;
            setError(null);
            submitting.current = true;
            setBusy(true);
            void importIssue({
              environmentId: project.environmentId,
              input: { projectId: project.id, issue: issue.trim() },
            })
              .then((result) => {
                if (result._tag === "Failure") setError(issueError(result.cause));
                if (result._tag === "Success") {
                  toastManager.add({ type: "success", title: "Issue imported" });
                  onClose();
                }
              })
              .finally(() => {
                submitting.current = false;
                setBusy(false);
              });
          }}
        >
          <DialogHeader>
            <DialogTitle>Import GitHub issue</DialogTitle>
            <DialogDescription>
              Create a ticket from an issue in the selected repository.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <TicketPicker
                label="Project"
                value={selected}
                disabled={busy}
                options={projects.map((p) => ({
                  value: key(p),
                  label: `${p.title}${ids.length > 1 ? ` · ${environments.find((e) => e.environmentId === p.environmentId)?.label ?? p.environmentId}` : ""}`,
                }))}
                onChange={setSelected}
              />
              <label className="grid gap-1.5">
                <span>Issue URL or number</span>
                <Input
                  aria-label="Issue URL or number"
                  placeholder="https://github.com/owner/repo/issues/42 or #42"
                  value={issue}
                  disabled={busy}
                  onChange={(event) => setIssue(event.target.value)}
                />
              </label>
            </div>
          </DialogPanel>
          {error ? (
            <div className="px-6 pb-4">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canImport || !project || !issue.trim() || busy}>
              Import issue
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
