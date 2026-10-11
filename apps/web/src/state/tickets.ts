import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomValue } from "@effect/atom-react";
import { createTicketEnvironmentAtoms } from "@t3tools/client-runtime/state/tickets";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";
import { environmentSummaries } from "./presentation";

export const ticketEnvironment = createTicketEnvironmentAtoms(connectionAtomRuntime);
export const ticketEnvironmentIdsAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  return get(environmentSummaries.connectedEnvironmentIdsAtom).filter(
    (id) => configs.get(id)?.environment.capabilities.tickets === true,
  );
});
export const allTicketsAtom = Atom.make((get) => {
  const entries: EnvironmentTicket[] = [];
  const errors: string[] = [];
  let loading = false;
  for (const environmentId of get(ticketEnvironmentIdsAtom)) {
    const result = get(ticketEnvironment.ticketsLive({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(result))
      entries.push(...result.value.tickets.map((ticket) => ({ environmentId, ticket })));
    else if (AsyncResult.isFailure(result))
      errors.push(`Could not load tickets from ${environmentId}.`);
    else loading = true;
  }
  return { entries, errors, loading };
});
export function useTicketsSupported() {
  return useAtomValue(ticketEnvironmentIdsAtom).length > 0;
}

export function readServerConfigForTickets(
  environmentId: import("@t3tools/contracts").EnvironmentId,
) {
  return appAtomRegistry.get(ticketEnvironmentIdsAtom).includes(environmentId);
}

export function useTicketWriteAllowed(
  environmentId: import("@t3tools/contracts").EnvironmentId | null,
) {
  return useAtomValue(ticketEnvironment.upsertTicket.permissionAtom(environmentId));
}

export const ticketGithubEnvironmentIdsAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  return get(ticketEnvironmentIdsAtom).filter(
    (id) => configs.get(id)?.environment.capabilities.ticketGithub === true,
  );
});
export function useTicketGithubSupported(
  environmentId: import("@t3tools/contracts").EnvironmentId,
) {
  return useAtomValue(ticketGithubEnvironmentIdsAtom).includes(environmentId);
}
