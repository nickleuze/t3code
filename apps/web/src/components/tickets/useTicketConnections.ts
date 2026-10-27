import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { ticketEnvironment, ticketEnvironmentIdsAtom } from "../../state/tickets";
import { useThreadShells } from "../../state/entities";
export function useTicketConnections(entry: EnvironmentTicket) {
  const machines = useAtomValue(
    Atom.make((get) => {
      const connected = new Map<string, { environmentId: EnvironmentId; label: string }>();
      for (const environmentId of get(ticketEnvironmentIdsAtom)) {
        const status = get(ticketEnvironment.syncStatus({ environmentId, input: {} }));
        if (AsyncResult.isSuccess(status))
          connected.set(status.value.machine, { environmentId, label: status.value.label });
      }
      return connected;
    }),
  );
  const machine =
    [...machines].find(([, value]) => value.environmentId === entry.environmentId)?.[0] ?? null;
  const shells = useThreadShells();
  const linked = entry.ticket.links.flatMap((link) => {
    const environmentId = link.machine
      ? machines.get(link.machine)?.environmentId
      : entry.environmentId;
    return shells
      .filter(
        (s) => s.environmentId === environmentId && s.id === link.threadId && s.deletedAt === null,
      )
      .map((thread) => ({ link, thread }));
  });
  return { machines, machine, linked };
}
