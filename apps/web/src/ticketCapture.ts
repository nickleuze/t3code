import { create } from "zustand";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
export const useTicketCapture = create<{
  request: { projectRef?: ScopedProjectRef; origin?: ScopedThreadRef } | null;
}>(() => ({ request: null }));
export function openTicketCapture(
  request: { projectRef?: ScopedProjectRef; origin?: ScopedThreadRef } = {},
) {
  useTicketCapture.setState({ request });
}
