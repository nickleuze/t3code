import type { EnvironmentId, ForkUpdateStatus } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CircleArrowUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Spinner } from "../ui/spinner";
import { SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type ForkUpdateMachine,
  forkUpdateConfirmationMessage,
  resolveForkUpdatePillView,
  shortForkVersion,
} from "./SidebarForkUpdatePill.logic";

type ReportStatus = (environmentId: EnvironmentId, status: ForkUpdateStatus | null) => void;

/** Reads one machine's fork update status; hooks cannot run per item of a list. */
function ForkUpdateProbe({
  environmentId,
  refreshKey,
  onStatus,
}: {
  readonly environmentId: EnvironmentId;
  readonly refreshKey: number;
  readonly onStatus: ReportStatus;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.forkUpdateStatus({ environmentId, input: {} }),
  );
  const { refresh } = query;
  useEffect(() => {
    onStatus(environmentId, query.data);
  }, [environmentId, onStatus, query.data]);
  useEffect(() => {
    if (refreshKey > 0) refresh();
  }, [refresh, refreshKey]);
  useEffect(() => () => onStatus(environmentId, null), [environmentId, onStatus]);
  return null;
}

/**
 * Fork-only: offers the newest fork release and installs it on every
 * connected machine that runs a fork build, remote machines first.
 */
export function SidebarForkUpdatePill() {
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { presentationById } = useEnvironments();
  const installForkUpdate = useAtomCommand(serverEnvironment.installForkUpdate, {
    reportFailure: false,
  });
  const [statuses, setStatuses] = useState<ReadonlyMap<EnvironmentId, ForkUpdateStatus>>(
    () => new Map(),
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [isPending, setIsPending] = useState(false);
  const pending = useRef(false);

  const environmentIds = useMemo(
    () =>
      [...serverConfigs]
        .filter(([, config]) => config.environment.capabilities.forkUpdates === true)
        .map(([environmentId]) => environmentId),
    [serverConfigs],
  );

  const reportStatus = useCallback<ReportStatus>((environmentId, status) => {
    setStatuses((previous) => {
      if ((previous.get(environmentId) ?? null) === status) return previous;
      const next = new Map(previous);
      if (status === null) next.delete(environmentId);
      else next.set(environmentId, status);
      return next;
    });
  }, []);

  const machines = useMemo<ReadonlyArray<ForkUpdateMachine>>(
    () =>
      [...statuses].map(([environmentId, status]) => ({
        environmentId,
        label: presentationById.get(environmentId)?.entry.target.label ?? environmentId,
        isPrimary: environmentId === primaryEnvironmentId,
        status,
      })),
    [presentationById, primaryEnvironmentId, statuses],
  );
  const view = resolveForkUpdatePillView(machines);

  const handleUpdate = async () => {
    if (!view || view.pending.length === 0 || pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      const confirmed =
        (await requestConfirmDialog(forkUpdateConfirmationMessage(view))) ??
        window.confirm(forkUpdateConfirmationMessage(view));
      if (!confirmed) return;
      // In order, so this machine's restart comes after the others started.
      for (const machine of view.pending) {
        const result = await installForkUpdate({ environmentId: machine.environmentId, input: {} });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) continue;
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: `${machine.label} update failed`,
            description: error instanceof Error ? error.message : "Fork update failed.",
          });
          continue;
        }
        toastManager.add({
          type: "success",
          title: `Updating ${machine.label} to ${shortForkVersion(result.value.version)}`,
          description: result.value.message,
        });
      }
    } finally {
      pending.current = false;
      setIsPending(false);
      setRefreshKey((key) => key + 1);
    }
  };

  const installing = view !== null && view.pending.length === 0;
  const disabled = isPending || installing;

  return (
    <>
      {environmentIds.map((environmentId) => (
        <ForkUpdateProbe
          key={environmentId}
          environmentId={environmentId}
          refreshKey={refreshKey}
          onStatus={reportStatus}
        />
      ))}
      {view ? (
        <SidebarMenuItem className="shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={view.tooltip}
                  aria-disabled={disabled || undefined}
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-full bg-sidebar-control-surface text-sidebar-foreground outline-hidden ring-ring transition-colors focus-visible:ring-2",
                    disabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-sidebar-row-hover",
                  )}
                  onClick={() => void handleUpdate()}
                >
                  {disabled ? <Spinner size="md" /> : <CircleArrowUpIcon className="size-4" />}
                </button>
              }
            />
            <TooltipPopup align="center" side="top" variant="glass">
              {view.tooltip}
            </TooltipPopup>
          </Tooltip>
        </SidebarMenuItem>
      ) : null}
    </>
  );
}
