import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  getNewProjectGitHubRepository,
  getNewProjectGitHubTarget,
  getNewProjectPathPreview,
} from "@t3tools/client-runtime/operations/projects";
import { newProjectFolderName } from "@t3tools/shared/path";
import {
  EnvironmentId,
  type ProjectCreateNewResult,
  type WorkModelProjectPreview,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useWorkModelProject } from "../../workModelProject";
import { useNewProject } from "../../hooks/useNewProject";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { projectEnvironment } from "../../state/projects";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { openTicketCapture } from "../../ticketCapture";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { TicketPicker } from "../tickets/TicketPicker";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
  const [environmentId, setEnvironmentId] = useState(request.environmentId);
  const environment = environments.find((e) => e.environmentId === environmentId);
  const machine = environment?.label ?? "Selected machine";
  const connected = environment?.connection.phase === "connected";
  const options = useEnvironmentQuery(
    projectEnvironment.workModelOptions({ environmentId, input: {} }),
  );
  // A failed refresh must not silently reuse a stale setup result.
  const available = options.error ? null : options.data;
  const inArea = (available?.areas.length ?? 0) > 0;
  const [basicCreation, setBasicCreation] = useState(false);
  const [basicReviewed, setBasicReviewed] = useState(false);
  const canCreate = useAtomValue(projectEnvironment.createNew.permissionAtom(environmentId));
  const canPublish = useAtomValue(
    sourceControlEnvironment.publishRepository.permissionAtom(environmentId),
  );
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const githubTarget = discovery.error ? null : getNewProjectGitHubTarget(discovery.data);
  const [publish, setPublish] = useState(false);
  const [reviewedGitHub, setReviewedGitHub] = useState<{ readonly account: string | null } | null>(
    null,
  );
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
  const details = {
    area,
    slug: slug ?? newProjectFolderName(name),
    purpose: purpose.trim(),
    ...(goal.trim() ? { goal: goal.trim() } : {}),
    ...(request.sourceIdeaId ? { sourceIdeaId: request.sourceIdeaId } : {}),
    adoptExisting: preview?.existingHome ?? false,
  };
  const basicRoot = environment?.serverConfig?.newProjectsRoot;
  const basicPath = basicRoot ? getNewProjectPathPreview(basicRoot, name) : null;
  const isReviewed = preview !== null || basicReviewed;
  const reviewMatchesSetup = (!preview || inArea) && (!basicReviewed || !inArea);
  const valid =
    canCreate &&
    reviewMatchesSetup &&
    connected &&
    !!name.trim() &&
    !options.isPending &&
    (inArea
      ? !!area && available!.areas.some((a) => a.name === area) && !!purpose.trim()
      : basicCreation && !!basicRoot && !request.sourceIdeaId);
  const back = () => {
    setPreview(null);
    setBasicReviewed(false);
    setError(null);
  };
  const submit = async () => {
    if (!valid || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!isReviewed) {
        if (inArea) {
          const result = await review({ environmentId, input: { name: name.trim(), ...details } });
          if (result._tag === "Failure") {
            const cause = squashAtomCommandFailure(result);
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not review the Home. Your input is kept.",
            );
            return;
          }
          setPreview(result.value);
          setReviewedGitHub(
            publish && canPublish && !result.value.existingHome ? githubTarget : null,
          );
        } else {
          setBasicReviewed(true);
          setReviewedGitHub(publish && canPublish ? githubTarget : null);
        }
        return;
      }
      if (
        reviewedGitHub &&
        (!canPublish || !githubTarget || githubTarget.account !== reviewedGitHub.account)
      ) {
        setError("GitHub availability changed. Go back and review the publication option again.");
        return;
      }
      const result = await create({
        environmentId,
        name: name.trim(),
        github: reviewedGitHub,
        ...(inArea ? { workModel: details } : {}),
      });
      if (result) {
        if (inArea) setCreated(result);
        else close();
      } else {
        setError(
          inArea
            ? "Creation did not finish. Your input and any created files are kept. Review the same Home to resume."
            : "Basic creation did not finish. Check the project list before retrying; retrying may create a numbered copy.",
        );
        setPreview(null);
        setBasicReviewed(false);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const size = narrow ? ("touch" as const) : ("default" as const);
  const reviewedPath = preview?.workspaceRoot ?? basicPath;
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
              {created ? "Project ready" : isReviewed ? "Review project setup" : "New project"}
            </DialogTitle>
            <DialogDescription>
              {`Machine: ${machine}`}
              {request.sourceIdeaId ? " · From Idea" : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {created ? (
              <div className="grid gap-4">
                <h3 className="text-lg font-medium">{group?.displayName ?? name}</h3>
                <p className="break-all text-sm">Project Home: {created.workspaceRoot}</p>
                <p className="text-sm">
                  Registered in T3 on {machine}. Its Home and durable identity remain independent of
                  this registration.
                </p>
                {request.sourceIdeaId ? (
                  <p>The Idea is closed as this Project’s origin. Its history is preserved.</p>
                ) : null}
                <p>Create the first actionable Ticket when you are ready. No work has started.</p>
                {!group ? (
                  <p role="status">
                    Waiting for this client to receive the registration. You can close this dialog
                    and find it in the project list when connected.
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  To remove this machine’s registration later, use Project settings. Removing it
                  keeps the Project Home files.
                </p>
              </div>
            ) : isReviewed ? (
              <div className="grid gap-4">
                <h3 className="text-lg font-medium">{name}</h3>
                {preview && !preview.existingHome ? <p>{purpose}</p> : null}
                <dl className="grid gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Destination machine</dt>
                    <dd>{machine}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {preview ? "Project Home" : "Basic project folder"}
                    </dt>
                    <dd className="break-all">{reviewedPath}</dd>
                  </div>
                  {preview ? (
                    <>
                      <div>
                        <dt className="text-muted-foreground">Area and scope</dt>
                        <dd>
                          {area} · {preview.scope}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Project identity (README)</dt>
                        <dd className="break-all">
                          {preview.projectIdentity ?? "Not reported by this server"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Ticket ID prefix</dt>
                        <dd className="break-all">{preview.projectKey}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Registration on this machine</dt>
                        <dd>
                          {preview.registeredProjectId
                            ? "Reuse existing T3 registration"
                            : "Add this Home to T3"}
                        </dd>
                      </div>
                      {goal && !preview.existingHome ? (
                        <div>
                          <dt className="text-muted-foreground">Current Goal</dt>
                          <dd>{goal}</dd>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  <div>
                    <dt className="text-muted-foreground">GitHub publication</dt>
                    <dd>
                      {preview?.existingHome
                        ? "Not offered when adopting. Use Publish Repository in the Git menu if needed."
                        : reviewedGitHub && reviewedPath
                          ? `Create private repository: ${getNewProjectGitHubRepository(reviewedGitHub, reviewedPath)}`
                          : "None"}
                    </dd>
                  </div>
                </dl>
                {preview?.existingHome ? (
                  <p>
                    Adopt this existing Home. Its files, purpose, Goal, identity and Ticket ID
                    prefix are preserved.
                  </p>
                ) : preview ? (
                  <p>
                    Creates README, STATUS, AGENTS, TOOLS and a local Git repository. GitHub
                    publication is optional.
                  </p>
                ) : (
                  <p>
                    Creates a basic Git repository and opens a thread draft. It has no Work Model
                    Area or Project Home setup. If the folder name is taken, T3 chooses a numbered
                    name.
                  </p>
                )}
                {request.sourceIdeaId ? (
                  <p>
                    The original Idea will close as the Project’s origin. Its history stays
                    available; the first work Ticket is a separate step.
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  Go back to change setup, or cancel before anything is created.
                </p>
              </div>
            ) : (
              <div className="grid gap-4">
                {!request.sourceIdeaId && environments.length > 1 ? (
                  <TicketPicker
                    label="Destination machine"
                    value={environmentId}
                    options={environments.map((e) => ({
                      value: e.environmentId,
                      label: `${e.label}${e.connection.phase === "connected" ? "" : " · Offline"}`,
                    }))}
                    onChange={(id) => {
                      setEnvironmentId(EnvironmentId.make(id));
                      setArea("");
                      setBasicCreation(false);
                      setPublish(false);
                      setReviewedGitHub(null);
                      back();
                    }}
                    disabled={busy}
                  />
                ) : null}
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
                    {options.error
                      ? "Project setup could not be loaded from this machine. It may be unavailable or unsupported by this server."
                      : "Loading project setup…"}
                  </p>
                ) : null}
                {inArea ? (
                  <>
                    <TicketPicker
                      label="Area"
                      value={area}
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
                      Project Home: {available!.projectsRoot}/{area || "<area>"}/{details.slug}
                    </p>
                    {!available!.initializerAvailable ? (
                      <p role="status">
                        This machine is missing project-init. Set it up on {machine} to create a new
                        Home. You can still review and adopt an existing Home.
                      </p>
                    ) : null}
                  </>
                ) : available ? (
                  <p role="status">
                    This machine has no Work Model Areas. Set up an Area on {machine} or choose
                    another machine to create a Project Home.
                  </p>
                ) : null}
                {options.error || (available && (!inArea || !available.initializerAvailable)) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size={size}
                    disabled={busy || !connected || options.isPending}
                    onClick={() => {
                      back();
                      options.refresh();
                    }}
                  >
                    Retry setup
                  </Button>
                ) : null}
                {!inArea && (available || options.error) && !request.sourceIdeaId && basicRoot ? (
                  <div className="grid gap-2">
                    <p className="text-sm text-muted-foreground">
                      Basic creation makes a Git repository in T3’s standard folder without a Work
                      Model Area or Home setup.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size={size}
                      disabled={busy}
                      onClick={() => setBasicCreation((value) => !value)}
                    >
                      {basicCreation ? "Use Work Model setup" : "Use basic creation"}
                    </Button>
                    {basicCreation ? (
                      <p className="break-all text-sm">Basic project folder: {basicPath}</p>
                    ) : null}
                  </div>
                ) : null}
                {request.sourceIdeaId && !inArea ? (
                  <p>
                    The Idea stays unchanged. Project creation from an Idea requires Work Model
                    setup on its machine.
                  </p>
                ) : null}
                {githubTarget && canPublish ? (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={publish}
                      onCheckedChange={(checked) => setPublish(Boolean(checked))}
                      disabled={busy}
                    />
                    Create private repository on GitHub (optional)
                  </label>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {canPublish
                      ? "GitHub publication is optional. Configure it in Source Control settings on this machine to enable it."
                      : "This connection cannot publish repositories. GitHub publication is optional."}
                  </p>
                )}
              </div>
            )}
            {!created && !reviewMatchesSetup ? (
              <p role="status">Setup changed since review. Go back and review again.</p>
            ) : null}
            {!created && !connected ? (
              <p role="status" className="mt-4">
                Connect {machine} to review or create here. Your input is kept.
              </p>
            ) : null}
            {!created && !canCreate ? (
              <p role="status" className="mt-4">
                This connection cannot create or register projects.
              </p>
            ) : null}
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
                  Project settings
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
                <Button type="button" variant="outline" size={size} disabled={busy} onClick={close}>
                  Cancel
                </Button>
                {isReviewed ? (
                  <Button
                    type="button"
                    variant="outline"
                    size={size}
                    disabled={busy}
                    onClick={back}
                  >
                    Back
                  </Button>
                ) : null}
                <Button type="submit" size={size} disabled={busy || !valid}>
                  {busy
                    ? "Working…"
                    : preview
                      ? preview.existingHome
                        ? "Adopt existing Home"
                        : "Create project"
                      : basicReviewed
                        ? "Create basic project"
                        : "Review setup"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
