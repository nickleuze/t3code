import {
  type EnvironmentId,
  type Ticket,
  type TicketId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  EnvironmentRpcUnavailableError,
  getInitialServerConfig,
  requestGuarded,
  subscribe,
  type EnvironmentRpcInput,
} from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export function ticketIdsByThread(
  tickets: ReadonlyArray<Ticket>,
): ReadonlyMap<ThreadId, ReadonlyArray<TicketId>> {
  const index = new Map<ThreadId, TicketId[]>();
  for (const ticket of tickets) {
    if (ticket.deletedAt !== null) continue;
    for (const link of ticket.links) {
      const ids = index.get(link.threadId) ?? [];
      if (!ids.includes(ticket.id)) ids.push(ticket.id);
      index.set(link.threadId, ids);
    }
  }
  return index;
}

export function createTicketEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const requireTickets = Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const config = yield* getInitialServerConfig().pipe(
      Effect.mapError(
        () =>
          new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: "Could not load this environment's ticket capability.",
          }),
      ),
    );
    if (config.environment.capabilities.tickets !== true) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId: config.environment.environmentId,
        message: "This environment does not support T3 tickets.",
      });
    }
  });
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: EnvironmentId }) => environmentId,
  };
  const withTickets = <A, Error, Context>(effect: Effect.Effect<A, Error, Context>) =>
    requireTickets.pipe(Effect.andThen(effect));
  const ticketsLive = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:server:tickets:live",
    subscribe: (_input: EnvironmentRpcInput<typeof WS_METHODS.ticketsSubscribe>) =>
      Stream.unwrap(requireTickets.pipe(Effect.as(subscribe(WS_METHODS.ticketsSubscribe, {})))),
  });
  const ticketIdsByThreadAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(ticketsLive({ environmentId, input: {} }));
      return ticketIdsByThread(AsyncResult.isSuccess(result) ? result.value.tickets : []);
    }).pipe(Atom.withLabel(`environment-data:server:tickets:thread-index:${environmentId}`)),
  );
  return {
    ticketsLive,
    ticketIdsByThreadAtom,
    upsertTicket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:tickets:upsert",
      tag: WS_METHODS.ticketsUpsert,
      scheduler,
      concurrency,
      execute: (input) => withTickets(requestGuarded(WS_METHODS.ticketsUpsert, input)),
    }),
    deleteTicket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:tickets:delete",
      tag: WS_METHODS.ticketsDelete,
      scheduler,
      concurrency,
      execute: (input) => withTickets(requestGuarded(WS_METHODS.ticketsDelete, input)),
    }),
    restoreTicket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:tickets:restore",
      tag: WS_METHODS.ticketsRestore,
      scheduler,
      concurrency,
      execute: (input) => withTickets(requestGuarded(WS_METHODS.ticketsRestore, input)),
    }),
    linkTicket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:tickets:link",
      tag: WS_METHODS.ticketsLink,
      scheduler,
      concurrency,
      execute: (input) => withTickets(requestGuarded(WS_METHODS.ticketsLink, input)),
    }),
    unlinkTicket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:tickets:unlink",
      tag: WS_METHODS.ticketsUnlink,
      scheduler,
      concurrency,
      execute: (input) => withTickets(requestGuarded(WS_METHODS.ticketsUnlink, input)),
    }),
  };
}
