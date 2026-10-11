import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  pendingTicketLinkOnPromotion,
  type PendingTicketLink,
} from "@t3tools/client-runtime/state/ticket-board";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { ticketEnvironment } from "./state/tickets";
import { toastManager } from "./components/ui/toast";

export const usePendingTicketDrafts = create(
  persist<{ links: Record<string, PendingTicketLink> }>(() => ({ links: {} }), {
    name: "t3-pending-ticket-drafts",
  }),
);
export function setPendingTicketDraft(draftId: string, pending: PendingTicketLink) {
  usePendingTicketDrafts.setState((state) => ({ links: { ...state.links, [draftId]: pending } }));
}
/** The composer may replace a failed bootstrap's thread id before retrying send. */
export async function linkFinalizedTicketDraft(draftId: string, threadRef: ScopedThreadRef) {
  const pending = usePendingTicketDrafts.getState().links[draftId];
  if (!pending || pending.environmentId !== threadRef.environmentId) return;
  setPendingTicketDraft(draftId, { ...pending, threadId: threadRef.threadId });
  await linkPromotedTicketDraft(draftId, threadRef);
}
const inFlight = new Set<string>();
export async function linkPromotedTicketDraft(draftId: string, threadRef: ScopedThreadRef) {
  const target = pendingTicketLinkOnPromotion(
    usePendingTicketDrafts.getState().links[draftId],
    threadRef,
  );
  if (!target || inFlight.has(draftId)) return;
  inFlight.add(draftId);
  try {
    const result = await runAtomCommand(appAtomRegistry, ticketEnvironment.linkTicket, target);
    if (result._tag === "Success") {
      usePendingTicketDrafts.setState((state) => {
        const links = { ...state.links };
        delete links[draftId];
        return { links };
      });
    } else {
      toastManager.add({
        type: "error",
        title: "Thread started, but ticket linking failed",
        actionProps: {
          children: "Retry",
          onClick: () => {
            void linkPromotedTicketDraft(draftId, threadRef);
          },
        },
      });
    }
  } finally {
    inFlight.delete(draftId);
  }
}
