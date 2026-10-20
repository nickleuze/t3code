import { create } from "zustand";
import type { EnvironmentId, TicketId } from "@t3tools/contracts";

type Request = {
  environmentId: EnvironmentId;
  name?: string;
  purpose?: string;
  sourceIdeaId?: TicketId;
};
export const useWorkModelProject = create<{ request: Request | null }>(() => ({ request: null }));
export function openWorkModelProject(request: Request) {
  useWorkModelProject.setState({ request });
}
