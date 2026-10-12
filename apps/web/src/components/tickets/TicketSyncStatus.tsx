import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ticketEnvironment } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Button } from "../ui/button";

export function TicketSyncStatus({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useMemo(
    () => ticketEnvironment.syncStatus({ environmentId, input: {} }),
    [environmentId],
  );
  const status = useAtomValue(query);
  const reload = useAtomRefresh(query);
  const refresh = useAtomCommand(ticketEnvironment.syncRefresh);
  const allowed = useAtomValue(ticketEnvironment.syncRefresh.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const interval = setInterval(reload, 15_000);
    return () => clearInterval(interval);
  }, [reload]);
  const value = AsyncResult.isSuccess(status) ? status.value : null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <Tooltip>
        <TooltipTrigger render={<span aria-live="polite" />}>
          {value
            ? !value.configured
              ? "Local tickets"
              : value.lastError
                ? `Offline · ${value.pendingEvents} pending`
                : value.pendingEvents
                  ? `${value.pendingEvents} pending`
                  : "Synced"
            : "Sync…"}
        </TooltipTrigger>
        <TooltipPopup>{value?.lastError ?? value?.remote ?? environmentId}</TooltipPopup>
      </Tooltip>
      <Button
        variant="ghost"
        size="xs"
        disabled={busy || !allowed}
        onClick={() => {
          setBusy(true);
          void refresh({ environmentId, input: {} }).finally(() => {
            setBusy(false);
            reload();
          });
        }}
      >
        Refresh
      </Button>
    </div>
  );
}
