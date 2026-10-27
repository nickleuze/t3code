import { Link } from "@tanstack/react-router";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ticketEnvironment } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";

export function TicketSyncStatus({ environmentId }: { environmentId: EnvironmentId }) {
  const query = ticketEnvironment.syncStatus({ environmentId, input: {} });
  const status = useAtomValue(query);
  const reload = useAtomRefresh(query);
  const refresh = useAtomCommand(ticketEnvironment.syncRefresh);
  const allowed = useAtomValue(ticketEnvironment.syncRefresh.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  // oxlint-disable-next-line t3code/react-effect-budget -- polls sync status while the badge is shown
  useEffect(() => {
    const interval = setInterval(reload, 15_000);
    return () => clearInterval(interval);
  }, [reload]);
  const value = AsyncResult.isSuccess(status) ? status.value : null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              variant="outline"
              aria-live="polite"
              render={
                value && !value.configured ? (
                  <Link
                    to="/settings/tickets"
                    aria-label="Sync not configured. Open Settings → Tickets"
                  />
                ) : undefined
              }
            />
          }
        >
          {value
            ? !value.configured
              ? "Sync not configured"
              : value.lastError
                ? `Offline · ${value.pendingEvents} pending`
                : value.pendingEvents
                  ? `${value.pendingEvents} pending`
                  : "Synced"
            : "Sync…"}
        </TooltipTrigger>
        <TooltipPopup>
          {value && !value.configured
            ? "Configure sync in Settings → Tickets"
            : (value?.lastError ?? value?.remote ?? environmentId)}
        </TooltipPopup>
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
