import { EnvironmentId, ProjectId, TicketId, type TicketStatus } from "@t3tools/contracts";
import { TICKET_COLUMNS } from "@t3tools/client-runtime/state/ticket-board";

export interface TicketsSearch {
  capture?: boolean;
  project?: ProjectId;
  environmentId?: EnvironmentId;
  projectId?: ProjectId;
  projectEnvironmentId?: EnvironmentId;
  unassigned?: boolean;
  search?: string;
  showAllDone?: boolean;
  showDropped?: boolean;
  deleted?: boolean;
  ticketId?: TicketId;
  ticketEnvironmentId?: EnvironmentId;
}
export const parseTicketsSearch = (search: Record<string, unknown>): TicketsSearch => ({
  ...(search.capture === 1 || search.capture === "1" || search.capture === true
    ? { capture: true }
    : {}),
  ...(typeof search.project === "string" && search.project.trim()
    ? { project: ProjectId.make(search.project) }
    : {}),
  ...(typeof search.environmentId === "string"
    ? { environmentId: EnvironmentId.make(search.environmentId) }
    : {}),
  ...(typeof search.projectId === "string" ? { projectId: ProjectId.make(search.projectId) } : {}),
  ...(typeof search.projectEnvironmentId === "string"
    ? { projectEnvironmentId: EnvironmentId.make(search.projectEnvironmentId) }
    : {}),
  ...(search.unassigned === true ? { unassigned: true } : {}),
  ...(typeof search.search === "string" ? { search: search.search } : {}),
  ...(search.showAllDone === true ? { showAllDone: true } : {}),
  ...(search.showDropped === true ? { showDropped: true } : {}),
  ...(search.deleted === true ? { deleted: true } : {}),
  ...(typeof search.ticketId === "string" ? { ticketId: TicketId.make(search.ticketId) } : {}),
  ...(typeof search.ticketEnvironmentId === "string"
    ? { ticketEnvironmentId: EnvironmentId.make(search.ticketEnvironmentId) }
    : {}),
});

export function ticketBoardColumns(
  showDropped: boolean,
  narrow: boolean,
  active: TicketStatus,
): readonly TicketStatus[] {
  const columns: readonly TicketStatus[] = showDropped
    ? [...TICKET_COLUMNS, "dropped"]
    : TICKET_COLUMNS;
  return narrow ? [columns.includes(active) ? active : "inbox"] : columns;
}
