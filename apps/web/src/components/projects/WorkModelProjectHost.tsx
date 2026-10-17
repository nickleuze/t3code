import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { newProjectFolderName } from "@t3tools/shared/path";
import type { ProjectCreateNewResult, WorkModelProjectPreview } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useWorkModelProject } from "../../workModelProject";
import { useNewProject } from "../../hooks/useNewProject";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { openTicketCapture } from "../../ticketCapture";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { TicketPicker } from "../tickets/TicketPicker";
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

export function WorkModelProjectHost() {
  const request = useWorkModelProject((state) => state.request);
  return request ? <ProjectDialog key={JSON.stringify(request)} /> : null;
}

function ProjectDialog() {
  const request = useWorkModelProject((state) => state.request)!;
  const narrow = useMediaQuery("(max-width: 480px)");
  const { environments } = useEnvironments();
  const environmentId = request.environmentId;
  const query = useMemo(
    () => projectEnvironment.workModelOptions({ environmentId, input: {} }),
    [environmentId],
  );
  const options = useAtomValue(query);
  const available = AsyncResult.isSuccess(options) ? options.value : null;
  const [basicCreation, setBasicCreation] = useState(false);
  const inArea = (available?.areas.length ?? 0) > 0;
  const canCreate = useAtomValue(projectEnvironment.createNew.permissionAtom(environmentId));
  const [name, setName] = useState(request.name ?? "");
  const [slug, setSlug] = useState<string | null>(null);
  const [area, setArea] = useState("");
  const [purpose, setPurpose] = useState(request.purpose ?? "");
  const [goal, setGoal] = useState("");
  const [preview, setPreview] = useState<WorkModelProjectPreview | null>(null);
  const [created, setCreated] = useState<ProjectCreateNewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const review = useAtomCommand(projectEnvironment.workModelPreview, { reportFailure: false });
  const create = useNewProject();
  const navigate = useNavigate();
  const groups = useSettingsProjectGroups();
  const group = created
    ? groups.find((g) =>
        g.memberProjects.some(
          (p) => p.environmentId === environmentId && p.id === created.projectId,
        ),
      )
    : null;
  const close = () => useWorkModelProject.setState({ request: null });
  const selectedArea = area;
  const details = {
    area: selectedArea,
    slug: slug ?? newProjectFolderName(name),
    purpose: purpose.trim(),
    ...(goal.trim() ? { goal: goal.trim() } : {}),
    ...(request.sourceIdeaId ? { sourceIdeaId: request.sourceIdeaId } : {}),
    adoptExisting: preview?.existingHome ?? false,
  };
  const valid =
    canCreate &&
    (!!available || basicCreation) &&
    !!name.trim() &&
    (!inArea || (!!selectedArea && !!purpose.trim())) &&
    (!request.sourceIdeaId || inArea);
  const submit = async () => {
    if (!valid || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (inArea && !preview) {
        const result = await review({ environmentId, input: { name: name.trim(), ...details } });
        if (result._tag === "Failure") {
          const cause = squashAtomCommandFailure(result);
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not review the Home. Your input is kept.",
          );
        } else setPreview(result.value);
        return;
      }
      const result = await create({
        environmentId,
        name: name.trim(),
        github: request.github ?? null,
        ...(inArea ? { workModel: details } : {}),
      });
      if (result) {
        if (inArea) setCreated(result);
        else close();
      } else {
        setError(
          "Creation did not finish. Your input and any created files are kept. Review the Home to resume.",
        );
        setPreview(null);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const size = narrow ? ("touch" as const) : ("default" as const);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup variant="mobile-fullscreen">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {created ? "Project ready" : preview ? "Review Project Home" : "New Project"}
            </DialogTitle>
            <DialogDescription>
              {environments.find((e) => e.environmentId === environmentId)?.label ??
                "Selected environment"}
              {request.sourceIdeaId ? " · From Idea" : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {created ? (
              <div className="grid gap-4">
                <h3 className="text-lg font-medium">{group?.displayName ?? name}</h3>
                <p className="break-all text-sm text-muted-foreground">{created.workspaceRoot}</p>
                {request.sourceIdeaId ? <p>The Idea is closed as this Project’s origin.</p> : null}
                <p>Create the first actionable Ticket when you are ready.</p>
              </div>
            ) : preview ? (
              <div className="grid gap-4">
                <h3 className="text-lg font-medium">{name}</h3>
                {!preview.existingHome ? <p>{purpose}</p> : null}
                <dl className="grid gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Area and scope</dt>
                    <dd>
                      {selectedArea} · {preview.scope}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Home</dt>
                    <dd className="break-all">{preview.workspaceRoot}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Ticket key</dt>
                    <dd>{preview.projectKey}</dd>
                  </div>
                  {goal && !preview.existingHome ? (
                    <div>
                      <dt className="text-muted-foreground">Current Goal</dt>
                      <dd>{goal}</dd>
                    </div>
                  ) : null}
                </dl>
                {preview.existingHome ? (
                  <p>
                    Adopt this existing Home. Its files, purpose, Goal and identity are preserved.
                  </p>
                ) : (
                  <p>Creates README, STATUS, AGENTS, TOOLS and a Git repository.</p>
                )}
                {request.sourceIdeaId ? (
                  <p>
                    The original Idea will close as the Project’s origin. Its history stays
                    available.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="grid gap-4">
                <label className="grid gap-1.5">
                  <span>Name</span>
                  <Input
                    size={size}
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                </label>
                {available === null ? (
                  <p role="status">
                    {AsyncResult.isFailure(options)
                      ? "Project setup could not be loaded from this machine."
                      : "Loading project setup…"}
                  </p>
                ) : null}
                {AsyncResult.isFailure(options) && !request.sourceIdeaId ? (
                  <div className="grid gap-2">
                    <p className="text-sm text-muted-foreground">
                      {basicCreation
                        ? "Creates in this machine’s standard T3 projects folder."
                        : "Older servers support basic creation in their standard T3 projects folder."}
                    </p>
                    {!basicCreation ? (
                      <Button
                        type="button"
                        variant="outline"
                        size={size}
                        onClick={() => setBasicCreation(true)}
                      >
                        Use basic creation
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {inArea ? (
                  <>
                    <TicketPicker
                      label="Area"
                      value={selectedArea}
                      options={[
                        { value: "", label: "Choose an Area" },
                        ...available!.areas.map((a) => ({
                          value: a.name,
                          label: `${a.name} · ${a.scope}`,
                        })),
                      ]}
                      onChange={setArea}
                      disabled={busy}
                    />
                    <label className="grid gap-1.5">
                      <span>Folder name</span>
                      <Input
                        size={size}
                        value={details.slug}
                        onChange={(e) => setSlug(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span>Purpose</span>
                      <Textarea
                        value={purpose}
                        onChange={(e) => setPurpose(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span>Current Goal (optional)</span>
                      <Textarea
                        value={goal}
                        onChange={(e) => setGoal(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <p className="break-all text-sm text-muted-foreground">
                      {available!.projectsRoot}/{selectedArea}/{details.slug}
                    </p>
                  </>
                ) : available ? (
                  <p className="text-sm text-muted-foreground">
                    {request.sourceIdeaId
                      ? "Choose a machine with existing Work Model Areas to create a Project from this Idea."
                      : "This machine has no Work Model Areas. It will use its standard T3 projects folder."}
                  </p>
                ) : null}
              </div>
            )}
            {error ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            {created ? (
              <>
                <Button type="button" variant="outline" size={size} onClick={close}>
                  Close
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size={size}
                  disabled={!group}
                  onClick={() => {
                    if (group) {
                      close();
                      void navigate({
                        to: "/settings/projects",
                        search: { project: group.projectKey, machine: environmentId },
                      });
                    }
                  }}
                >
                  Open Project
                </Button>
                <Button
                  type="button"
                  size={size}
                  disabled={!group}
                  onClick={() => {
                    close();
                    openTicketCapture({
                      projectRef: scopeProjectRef(environmentId, created.projectId),
                    });
                  }}
                >
                  Create first Ticket
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size={size}
                  disabled={busy}
                  onClick={() => (preview ? setPreview(null) : close())}
                >
                  {preview ? "Back" : "Cancel"}
                </Button>
                <Button type="submit" size={size} disabled={busy || !valid}>
                  {busy
                    ? "Working…"
                    : preview
                      ? preview.existingHome
                        ? "Adopt existing Home"
                        : "Create Project"
                      : inArea
                        ? "Review"
                        : "Create Project"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
