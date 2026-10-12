import {
  CommandId,
  ThreadId,
  type EnvironmentId,
  type TicketId,
  type TicketStartInput,
  type TicketStartMode,
  type ProjectId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ticketEnvironment } from "../../state/tickets";
import { randomUUID } from "../../lib/utils";

export type TicketLaunchRequest = { environmentId: EnvironmentId; input: TicketStartInput };
type LaunchResult = Awaited<ReturnType<typeof ticketEnvironment.startTicket.run>>;

export function ticketLaunchRequest(
  pending: TicketLaunchRequest | null,
  environmentId: EnvironmentId,
  ticketId: TicketId,
  mode: TicketStartMode,
  projectId?: ProjectId,
): TicketLaunchRequest {
  if (
    pending?.environmentId === environmentId &&
    pending.input.ticketId === ticketId &&
    pending.input.mode === mode &&
    (projectId === undefined || pending.input.projectId === projectId)
  )
    return pending;
  return {
    environmentId,
    input: {
      ticketId,
      mode,
      threadId: ThreadId.make(randomUUID()),
      commandId: CommandId.make(randomUUID()),
      ...(projectId ? { projectId } : {}),
      creationSource: "web",
    },
  };
}

export function ticketLaunchFailureTag(result: LaunchResult) {
  if (result._tag === "Success") return undefined;
  const error = squashAtomCommandFailure(result);
  return error && typeof error === "object" && "_tag" in error ? error._tag : undefined;
}

/** Refresh only a missing projection, once, and preserve the launch receipt IDs. */
export async function startTicketWithRefresh(
  request: TicketLaunchRequest,
  start: (request: TicketLaunchRequest) => Promise<LaunchResult>,
  refresh: () => Promise<unknown>,
) {
  const result = await start(request);
  if (ticketLaunchFailureTag(result) !== "TicketNotFound") return result;
  await refresh();
  return start(request);
}
