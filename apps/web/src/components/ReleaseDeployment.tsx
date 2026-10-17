import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useId, useState } from "react";

import type {
  ReleaseAcceptanceTarget,
  ReleaseApproval,
  ReleaseDeploymentController,
} from "../hooks/useReleaseDeployment";
import type { EnvironmentPresentation } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import {
  type DeploymentRow,
  environmentDeploymentStatus,
  releaseTargetSequence,
  shortReleaseDigest,
} from "./releaseDeployment.logic";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

/** Approval is what authorizes the deployment; it pins the release identity shown here. */
export function ReleaseApprovalDialog({
  approval,
  onApprove,
  onCancel,
}: {
  readonly approval: ReleaseApproval;
  readonly onApprove: (acceptanceScope: string) => void;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const [scope, setScope] = useState("");
  const { manifest, targets } = approval;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogPopup>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (scope.trim() !== "") onApprove(scope);
          }}
        >
          <DialogHeader>
            <DialogTitle>Approve release {manifest.version}</DialogTitle>
            <DialogDescription>
              Approving authorizes this exact release to install on each host in order. Each host
              waits until it is idle and backs up its state before installing.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Commit</dt>
              <dd className="font-mono">{shortReleaseDigest(manifest.commit)}</dd>
              <dt className="text-muted-foreground">SHA-256</dt>
              <dd className="font-mono">{shortReleaseDigest(manifest.artifactSha256)}</dd>
              <dt className="text-muted-foreground">Feed</dt>
              <dd>
                {manifest.feed.owner}/{manifest.feed.repo}
              </dd>
              <dt className="text-muted-foreground">Order</dt>
              <dd>{releaseTargetSequence(targets)}</dd>
            </dl>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-scope`}>
                What should each host&apos;s acceptance check confirm?
              </Label>
              <Textarea
                id={`${id}-scope`}
                required
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={scope.trim() === ""}>
              Approve
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** The acceptance receipt confirms the scope fixed at approval; only the summary is new. */
export function ReleaseAcceptanceDialog({
  target,
  onSubmit,
  onCancel,
}: {
  readonly target: ReleaseAcceptanceTarget;
  readonly onSubmit: (summary: string) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const [summary, setSummary] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogPopup>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (summary.trim() === "" || pending) return;
            setPending(true);
            void onSubmit(summary).finally(() => setPending(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Record acceptance on {target.label}</DialogTitle>
            <DialogDescription>
              {target.request.version} is installed and verified. Confirm the approved scope works
              on this host.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-scope`}>Scope</Label>
              <Textarea id={`${id}-scope`} readOnly value={target.request.acceptanceScope} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-summary`}>What did you confirm?</Label>
              <Textarea
                id={`${id}-summary`}
                required
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={summary.trim() === "" || pending}>
              Record acceptance
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function DeploymentRowView({
  row,
  deployment,
}: {
  readonly row: DeploymentRow;
  readonly deployment: ReleaseDeploymentController;
}) {
  const environmentId: EnvironmentId = row.environmentId;
  const canRetry = useAtomValue(serverEnvironment.retryDeployment.permissionAtom(environmentId));
  const canCancel = useAtomValue(serverEnvironment.cancelDeployment.permissionAtom(environmentId));
  const canAccept = useAtomValue(
    serverEnvironment.recordDeploymentAcceptance.permissionAtom(environmentId),
  );
  const request = deployment.request;
  const reached = row.milestones.filter((milestone) => milestone.reached);
  return (
    <div className="flex flex-col gap-1">
      <p>
        <span className="font-medium">{row.label}</span>: {row.statusText}
      </p>
      {row.offline ? <p role="status">{row.offline}</p> : null}
      {row.reason ? (
        <p role={row.actions.includes("retry") ? "alert" : undefined}>{row.reason}</p>
      ) : null}
      {reached.length > 0 ? (
        <p>Reached: {reached.map((milestone) => milestone.label.toLowerCase()).join(", ")}</p>
      ) : null}
      {row.actions.length > 0 && request !== null ? (
        <div className="flex gap-1">
          {row.actions.includes("retry") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canRetry}
              onClick={() => void deployment.retry(row.environmentId, row.label)}
            >
              Retry {row.label}
            </Button>
          ) : null}
          {row.actions.includes("cancel") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canCancel}
              onClick={() => void deployment.cancel(row.environmentId, row.label)}
            >
              Cancel {row.label}
            </Button>
          ) : null}
          {row.actions.includes("accept") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canAccept}
              onClick={() =>
                deployment.openAcceptance({
                  environmentId: row.environmentId,
                  label: row.label,
                  request,
                })
              }
            >
              Record acceptance
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Popover body for the sidebar update control while a release is visible. */
export function ReleaseDeploymentDetails({
  deployment,
}: {
  readonly deployment: ReleaseDeploymentController;
}) {
  const canAdmit = useAtomValue(
    serverEnvironment.admitDeployment.permissionAtom(deployment.localEnvironmentId),
  );
  if (deployment.request === null) return null;
  return (
    <div className="flex max-w-80 flex-col gap-2 text-xs">
      <p className="font-medium">
        Release {deployment.request.version}: {releaseTargetSequence(deployment.request.targets)}
      </p>
      {deployment.rows.map((row) => (
        <DeploymentRowView key={row.environmentId} row={row} deployment={deployment} />
      ))}
      {deployment.override ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!canAdmit}
          onClick={() => void deployment.installLocalOnly()}
        >
          Install on this Mac only
        </Button>
      ) : null}
      {deployment.done ? (
        <p className="font-medium">Done: every host accepted this release.</p>
      ) : null}
    </div>
  );
}

/** Settings → Connections: the latest release on one host, read-only. */
export function EnvironmentDeploymentStatus({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const supported =
    environment.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.hostDeployments === true;
  const query = useEnvironmentQuery(
    supported
      ? serverEnvironment.deploymentsLive({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  const status = query.data ? environmentDeploymentStatus(query.data.deployments) : null;
  if (status === null) return null;
  return (
    <span
      className={cn("block text-xs", status.stopped ? "text-destructive" : "text-muted-foreground")}
    >
      Deployment {status.text}
      {status.reason ? ` — ${status.reason}` : ""}
    </span>
  );
}
