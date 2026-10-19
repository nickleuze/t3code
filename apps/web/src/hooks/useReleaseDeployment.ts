import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopReleaseManifest,
  DesktopUpdateState,
  EnvironmentId,
  HostDeployment,
  HostDeploymentRequest,
} from "@t3tools/contracts";
import {
  releaseDeploymentDone,
  runReleaseDeployment,
} from "@t3tools/client-runtime/state/hostDeployments";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { UpdateAllState } from "@t3tools/client-runtime/state/updateAllMachines";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  buildReleaseDeploymentRequest,
  currentReleaseRequest,
  deploymentRows,
  localOnlyOverride,
  orderReleaseTargets,
  type ReleaseApprovalTarget,
  releaseDeploymentEligible,
  releaseDeploymentSummary,
  releaseRecords,
  releaseToResume,
} from "../components/releaseDeployment.logic";
import { toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { newestKnownUpdateVersion } from "../serverUpdateTargets";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useServerUpdateTargets } from "./useServerUpdateTargets";

export interface ReleaseApproval {
  readonly manifest: DesktopReleaseManifest;
  readonly targets: ReadonlyArray<ReleaseApprovalTarget>;
}

export interface ReleaseAcceptanceTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly request: HostDeploymentRequest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The deployment request failed.";
}

async function unwrap<A, E>(pending: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const result = await pending;
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new Error("The deployment request was interrupted.");
  throw squashAtomCommandFailure(result);
}

/** Every capable host's records plus the release the update control shows. */
function deploymentRecordsAtom(idsKey: string) {
  const ids = idsKey === "" ? [] : (idsKey.split(",") as EnvironmentId[]);
  return Atom.make((get) => {
    const records = new Map<EnvironmentId, ReadonlyArray<HostDeployment>>();
    for (const environmentId of ids) {
      const result = get(serverEnvironment.deploymentsLive({ environmentId, input: {} }));
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) records.set(environmentId, value.deployments);
    }
    // "Recently finished" is judged when the records change, not on every render.
    return { records, request: currentReleaseRequest(records, Date.now()) };
  });
}

/**
 * Approved, idle-gated release deployment for the desktop update control.
 * Hosts own their records; this client approves the release, sequences
 * remotes before this machine, and resumes that sequence after a restart.
 */
export function useReleaseDeployment(
  localState: DesktopUpdateState | null,
  hasLocalUpdate: boolean,
) {
  const version = newestKnownUpdateVersion(localState);
  const remoteTargets = useServerUpdateTargets(version, true);
  const primary = usePrimaryEnvironment();
  const { environments } = useEnvironments();
  const primaryId = primary?.environmentId ?? null;
  const canRequestLocally = useAtomValue(
    serverEnvironment.requestDeployment.permissionAtom(primaryId),
  );

  const capableIdsKey = environments
    .filter((environment) => environment.serverConfig?.environment.capabilities.hostDeployments)
    .map((environment) => environment.environmentId)
    .toSorted()
    .join(",");
  const recordsAtom = useMemo(() => deploymentRecordsAtom(capableIdsKey), [capableIdsKey]);
  const { records: recordsByEnvironment, request } = useAtomValue(recordsAtom);

  const supports = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.capabilities.hostDeployments === true;
  const eligible = releaseDeploymentEligible({
    hasManifestBridge: typeof window.desktopBridge?.getReleaseManifest === "function",
    localSupported: primaryId !== null && supports(primaryId),
    canRequestLocally,
    hasLocalUpdate,
    remotesSupported: remoteTargets.map((target) => supports(target.environmentId)),
  });

  const [run, setRun] = useState<UpdateAllState | null>(null);
  const [running, setRunning] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [approval, setApproval] = useState<ReleaseApproval | null>(null);
  const [acceptance, setAcceptance] = useState<ReleaseAcceptanceTarget | null>(null);
  const active = useRef(false);
  const rerun = useRef<HostDeploymentRequest | null>(null);
  const resumed = useRef(new Set<string>());

  const requestCommand = useAtomCommand(serverEnvironment.requestDeployment, {
    reportFailure: false,
  });
  const awaitCommand = useAtomCommand(serverEnvironment.awaitDeployment, { reportFailure: false });
  const admitCommand = useAtomCommand(serverEnvironment.admitDeployment, { reportFailure: false });
  const retryCommand = useAtomCommand(serverEnvironment.retryDeployment, { reportFailure: false });
  const cancelCommand = useAtomCommand(serverEnvironment.cancelDeployment, {
    reportFailure: false,
  });
  const acceptCommand = useAtomCommand(serverEnvironment.recordDeploymentAcceptance, {
    reportFailure: false,
  });

  const sequence = async (request: HostDeploymentRequest): Promise<void> => {
    if (active.current) {
      // Picked up when the running sequence settles, e.g. after a retry.
      rerun.current = request;
      return;
    }
    active.current = true;
    setRunning(true);
    try {
      await runReleaseDeployment({
        request,
        submit: async (environmentId, next) =>
          (await unwrap(requestCommand({ environmentId, input: { request: next } }))).deployment,
        awaitDeployment: (environmentId, until) =>
          unwrap(awaitCommand({ environmentId, input: { releaseId: request.releaseId, until } })),
        admit: async (environmentId, mode, evidence) =>
          (
            await unwrap(
              admitCommand({
                environmentId,
                input: { releaseId: request.releaseId, mode, evidence },
              }),
            )
          ).deployment,
        onState: setRun,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not deploy ${request.version}`,
        description: errorMessage(error),
      });
    } finally {
      active.current = false;
      setRunning(false);
      const next = rerun.current;
      rerun.current = null;
      if (next !== null) void sequence(next);
    }
  };

  const records = useMemo(
    () =>
      request === null
        ? new Map<string, HostDeployment>()
        : releaseRecords(request, recordsByEnvironment),
    [recordsByEnvironment, request],
  );
  const connectedIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => environment.connection.phase === "connected")
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const runErrors = useMemo(() => {
    if (run === null || request === null) return {};
    const errors: Record<string, string> = {};
    for (const [environmentId, state] of Object.entries(run.remotes)) {
      if (state.status === "failed") errors[environmentId] = state.message;
    }
    const local = request.targets.find((target) => target.role === "local");
    if (local !== undefined && run.localError !== undefined) {
      errors[local.environmentId] = run.localError;
    }
    return errors;
  }, [request, run]);
  const rows =
    request === null ? [] : deploymentRows({ request, records, connectedIds, runErrors });
  const done = request !== null && releaseDeploymentDone(request, records);
  const override = request === null ? null : localOnlyOverride({ request, records, connectedIds });

  // Resume once per release: the sequence settles by itself when a remote
  // stops, and only a retry or approval should start it again.
  const resumeRequest =
    primaryId === null ? null : releaseToResume(recordsByEnvironment.get(primaryId) ?? []);
  const resume = useEffectEvent((releaseId: string) => {
    if (resumeRequest === null || resumed.current.has(releaseId)) return;
    resumed.current.add(releaseId);
    void sequence(resumeRequest);
  });
  // Keyed by release so a record update does not restart the sequence.
  const resumeReleaseId = resumeRequest?.releaseId ?? null;
  useEffect(() => {
    if (resumeReleaseId !== null) resume(resumeReleaseId);
  }, [resumeReleaseId]);

  const beginApproval = async () => {
    const bridge = window.desktopBridge;
    if (!bridge?.getReleaseManifest || preparing) return;
    setPreparing(true);
    try {
      const result = await bridge.getReleaseManifest(version);
      if (!result.ok) {
        toastManager.add({
          type: "error",
          title: `Could not read release ${version}`,
          description: result.reason,
        });
        return;
      }
      setApproval({
        manifest: result.manifest,
        targets: orderReleaseTargets(remoteTargets, hasLocalUpdate ? primaryId : null),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not read release ${version}`,
        description: errorMessage(error),
      });
    } finally {
      setPreparing(false);
    }
  };

  const approve = async (acceptanceScope: string) => {
    if (approval === null) return;
    let next: HostDeploymentRequest;
    try {
      next = buildReleaseDeploymentRequest({
        manifest: approval.manifest,
        targets: approval.targets,
        acceptanceScope,
        approvedAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not approve the release",
        description: errorMessage(error),
      });
      return;
    }
    setApproval(null);
    resumed.current.add(next.releaseId);
    await sequence(next);
  };

  const runAction = async <A, E>(title: string, pending: Promise<AtomCommandResult<A, E>>) => {
    try {
      await unwrap(pending);
      return true;
    } catch (error) {
      toastManager.add({ type: "error", title, description: errorMessage(error) });
      return false;
    }
  };

  const retry = async (environmentId: EnvironmentId, label: string) => {
    if (request === null) return;
    const ok = await runAction(
      `Could not retry ${label}`,
      retryCommand({ environmentId, input: { releaseId: request.releaseId } }),
    );
    // The previous sequence settled on the stopped host; sequence it again.
    if (ok && request.targets.some((target) => target.role === "local")) void sequence(request);
  };

  const cancel = async (environmentId: EnvironmentId, label: string) => {
    if (request === null) return;
    await runAction(
      `Could not cancel ${label}`,
      cancelCommand({ environmentId, input: { releaseId: request.releaseId } }),
    );
  };

  const recordAcceptance = async (summary: string) => {
    if (acceptance === null) return false;
    const ok = await runAction(
      `Could not record acceptance on ${acceptance.label}`,
      acceptCommand({
        environmentId: acceptance.environmentId,
        input: {
          releaseId: acceptance.request.releaseId,
          scope: acceptance.request.acceptanceScope,
          summary: summary.trim(),
        },
      }),
    );
    if (ok) setAcceptance(null);
    return ok;
  };

  const installLocalOnly = async () => {
    const local = request?.targets.find((target) => target.role === "local");
    if (request === null || override === null || local === undefined) return;
    const confirmed = (await requestConfirmDialog(override.confirmation)) ?? true;
    if (!confirmed) return;
    await runAction(
      "Could not install on this machine",
      admitCommand({
        environmentId: local.environmentId,
        input: { releaseId: request.releaseId, mode: "local-only", evidence: override.evidence },
      }),
    );
  };

  return {
    eligible,
    version,
    preparing,
    running,
    request,
    rows,
    done,
    override,
    summary: request === null ? null : releaseDeploymentSummary(request, rows, done),
    localEnvironmentId:
      request?.targets.find((target) => target.role === "local")?.environmentId ?? null,
    approval,
    acceptance,
    beginApproval,
    approve,
    dismissApproval: () => setApproval(null),
    openAcceptance: (target: ReleaseAcceptanceTarget) => setAcceptance(target),
    dismissAcceptance: () => setAcceptance(null),
    recordAcceptance,
    retry,
    cancel,
    installLocalOnly,
  };
}

export type ReleaseDeploymentController = ReturnType<typeof useReleaseDeployment>;
