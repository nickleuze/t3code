import type {
  EnvironmentId,
  OrchestrationV2ThreadLaunchInput,
  ThreadId,
  TicketId,
  TicketLinkInput,
  TicketUnlinkInput,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

type LaunchInput = OrchestrationV2ThreadLaunchInput & { threadId: ThreadId };
type Result<A> = AtomCommandResult<A, unknown>;

/** Only failures known to occur before thread creation may remove the link. */
function rejectedBeforeLaunch(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("_tag" in error)) return false;
  if (error._tag === "EnvironmentAuthorizationError") return true;
  if (error._tag !== "OrchestrationV2ThreadLaunchError" || !("cause" in error)) return false;
  const cause = error.cause;
  if (!cause || typeof cause !== "object" || !("_tag" in cause)) return false;
  return (
    cause._tag === "AttachmentClaimError" ||
    (cause._tag === "ThreadLaunchError" &&
      "operation" in cause &&
      cause.operation === "resolve-project")
  );
}

export async function launchLinkedTicketThread({
  environmentId,
  ticketId,
  input,
  link,
  launch,
  unlink,
  unlinkOnRejection = true,
}: {
  environmentId: EnvironmentId;
  ticketId: TicketId;
  input: LaunchInput;
  unlinkOnRejection?: boolean;
  link: (value: {
    environmentId: EnvironmentId;
    input: TicketLinkInput;
  }) => Promise<Result<unknown>>;
  launch: (value: {
    environmentId: EnvironmentId;
    input: OrchestrationV2ThreadLaunchInput;
  }) => Promise<Result<{ threadId: ThreadId }>>;
  unlink: (value: {
    environmentId: EnvironmentId;
    input: TicketUnlinkInput;
  }) => Promise<Result<unknown>>;
}) {
  const linked = await link({
    environmentId,
    input: {
      id: ticketId,
      threadId: input.threadId,
      role: input.interactionMode === "plan" ? "planning" : "work",
      title: input.title,
    },
  });
  if (linked._tag !== "Success") return { step: "link" as const, result: linked };
  const result = await launch({ environmentId, input });
  const rejected =
    result._tag === "Failure" && rejectedBeforeLaunch(squashAtomCommandFailure(result));
  if (rejected && unlinkOnRejection) {
    await unlink({ environmentId, input: { id: ticketId, threadId: input.threadId } });
  }
  return { step: "launch" as const, result, rejected };
}
