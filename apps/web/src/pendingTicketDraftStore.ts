import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage } from "./lib/storage";
import type { PendingTicketLink } from "@t3tools/client-runtime/state/ticket-board";

export const usePendingTicketDrafts = create(
  persist<{ links: Record<string, PendingTicketLink> }>(() => ({ links: {} }), {
    name: "t3-pending-ticket-drafts",
    storage: createJSONStorage(() =>
      typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
    ),
  }),
);
export function setPendingTicketDraft(draftId: string, pending: PendingTicketLink) {
  usePendingTicketDrafts.setState((state) => ({ links: { ...state.links, [draftId]: pending } }));
}
export function clearPendingTicketDraft(draftId: string) {
  usePendingTicketDrafts.setState((state) => {
    if (!state.links[draftId]) return state;
    const links = { ...state.links };
    delete links[draftId];
    return { links };
  });
}
export function prunePendingTicketDrafts(draftIds: ReadonlySet<string>) {
  usePendingTicketDrafts.setState((state) => {
    const links = Object.fromEntries(
      Object.entries(state.links).filter(([draftId]) => draftIds.has(draftId)),
    );
    return Object.keys(links).length === Object.keys(state.links).length ? state : { links };
  });
}
