import type { ScopedThreadRef } from "@t3tools/contracts";
import { pendingTicketLinkOnPromotion } from "@t3tools/client-runtime/state/ticket-board";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { ticketEnvironment } from "./state/tickets";
import { toastManager } from "./components/ui/toast";

import { clearPendingTicketDraft, usePendingTicketDrafts } from "./pendingTicketDraftStore";
export { setPendingTicketDraft, usePendingTicketDrafts } from "./pendingTicketDraftStore";

/** The composer may replace a failed bootstrap's thread id before retrying send. */
export async function linkFinalizedTicketDraft(
  draftId: string,
  threadRef: ScopedThreadRef,
  pending = usePendingTicketDrafts.getState().links[draftId],
) {
  if (!pending || pending.environmentId !== threadRef.environmentId) return;
  await linkPromotedTicketDraft(draftId, threadRef, { ...pending, threadId: threadRef.threadId });
}
const inFlight = new Set<string>();
export async function linkPromotedTicketDraft(
  draftId: string,
  threadRef: ScopedThreadRef,
  pending = usePendingTicketDrafts.getState().links[draftId],
) {
  const target = pendingTicketLinkOnPromotion(pending, threadRef);
  if (!target || inFlight.has(draftId)) return;
  inFlight.add(draftId);
  try {
    const result = await runAtomCommand(appAtomRegistry, ticketEnvironment.linkTicket, target);
    if (result._tag === "Success") {
      clearPendingTicketDraft(draftId);
    } else {
      toastManager.add({
        type: "error",
        title: "Thread started, but ticket linking failed",
        actionProps: {
          children: "Retry",
          onClick: () => {
            void linkPromotedTicketDraft(draftId, threadRef, pending);
          },
        },
      });
    }
  } finally {
    inFlight.delete(draftId);
  }
}
