import { useTicketWriteAllowed } from "../state/tickets";
import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, TicketId, type TicketStatus } from "@t3tools/contracts";
import {
  groupTicketBoard,
  ticketEntryKey,
  ticketInsertionSortKeys,
  TICKET_COLUMNS,
  TICKET_STATUS_LABELS,
  type EnvironmentTicket,
} from "@t3tools/client-runtime/state/ticket-board";
import { deriveTicketStatus } from "@t3tools/shared/ticket";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowUpRightIcon, GripVerticalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TicketSyncStatus } from "../components/tickets/TicketSyncStatus";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { SidebarInset } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { Input } from "../components/ui/input";
import { TicketPicker } from "../components/tickets/TicketPicker";
import { TicketActions } from "../components/tickets/TicketActions";
import { TicketMarkers } from "../components/tickets/TicketMarkers";
import { TicketLinks } from "../components/tickets/TicketLinks";
import { TicketDetail } from "../components/tickets/TicketDetail";
import { TicketStartWork } from "../components/tickets/TicketStartWork";
import { openTicketCapture } from "../ticketCapture";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { allTicketsAtom, ticketEnvironmentIdsAtom, ticketEnvironment } from "../state/tickets";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { parseTicketsSearch, ticketBoardColumns, type TicketsSearch } from "../ticketsSearch";
import { isElectron } from "../env";

export const Route = createFileRoute("/_chat/tickets")({
  validateSearch: parseTicketsSearch,
  component: TicketsPage,
});
function TicketsPage() {
  const search = Route.useSearch();
  const narrow = useMediaQuery("(max-width: 480px)");
  const [activeStatus, setActiveStatus] = useState<TicketStatus>("inbox");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const captureOpened = useRef(false);
  const [now] = useState(() => Date.now());
  const navigate = useNavigate();
  const ids = useAtomValue(ticketEnvironmentIdsAtom);
  const { entries, errors, loading } = useAtomValue(allTicketsAtom);
  const projects = useProjects();
  const shells = useThreadShells();
  const { environments } = useEnvironments();
  const upsert = useAtomCommand(ticketEnvironment.upsertTicket);
  const sensors = useSensors(useSensor(PointerSensor));
  useEffect(() => {
    if (!search.capture) {
      captureOpened.current = false;
      return;
    }
    if (captureOpened.current || !ids.length || loading) return;
    captureOpened.current = true;
    const project = projects.find(
      (p) =>
        p.id === search.project &&
        ids.includes(p.environmentId) &&
        (!search.environmentId || p.environmentId === search.environmentId),
    );
    openTicketCapture(
      project ? { projectRef: scopeProjectRef(project.environmentId, project.id) } : {},
    );
    const { capture: _capture, project: _project, ...rest } = search;
    void navigate({ to: "/tickets", search: rest, replace: true });
  }, [search, ids, loading, projects, navigate]);
  useEffect(() => {
    const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!manifest) return;
    const previous = manifest.getAttribute("href");
    manifest.href = "/tickets-capture.webmanifest";
    return () => {
      if (previous !== null) manifest.setAttribute("href", previous);
    };
  }, []);
  const setFilters = (patch: { [K in keyof TicketsSearch]?: TicketsSearch[K] | undefined }) => {
    const next: TicketsSearch = { ...search };
    for (const key of Object.keys(patch) as (keyof TicketsSearch)[]) {
      if (patch[key] === undefined) delete next[key];
      else Object.assign(next, { [key]: patch[key] });
    }
    void navigate({ to: "/tickets", search: next, replace: true });
  };
  const groups = groupTicketBoard(entries, {
    ...search,
    projectId: search.unassigned ? "none" : search.projectId,
    projectExists: (env, id) => projects.some((p) => p.environmentId === env && p.id === id),
    now,
    threadById: (env, id) => shells.find((s) => s.environmentId === env && s.id === id)?.source,
  });
  const selected = entries.find(
    (e) => e.ticket.id === search.ticketId && e.environmentId === search.ticketEnvironmentId,
  );
  const open = (entry: EnvironmentTicket) =>
    setFilters({ ticketId: entry.ticket.id, ticketEnvironmentId: entry.environmentId });
  const drop = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const source = entries.find((e) => ticketEntryKey(e) === active.id);
    if (!source) return;
    const targetEntry = entries.find((e) => ticketEntryKey(e) === over.id);
    const targetStatus = targetEntry
      ? deriveTicketStatus(
          targetEntry.ticket,
          (id) =>
            shells.find((s) => s.environmentId === targetEntry.environmentId && s.id === id)
              ?.source,
        )
      : (over.data.current?.status as TicketStatus | undefined);
    if (!targetStatus) return;
    const column = groups[targetStatus].filter((e) => ticketEntryKey(e) !== active.id);
    const fromStatus = deriveTicketStatus(
      source.ticket,
      (id) => shells.find((s) => s.environmentId === source.environmentId && s.id === id)?.source,
    );
    const fromIndex = groups[fromStatus].findIndex((e) => ticketEntryKey(e) === active.id);
    const overIndex = groups[targetStatus].findIndex((e) => ticketEntryKey(e) === over.id);
    const index = targetEntry
      ? Math.max(
          0,
          column.findIndex((e) => ticketEntryKey(e) === over.id) +
            (fromStatus === targetStatus && fromIndex < overIndex ? 1 : 0),
        )
      : column.length;
    const patches = ticketInsertionSortKeys(column, source, index);
    // Keep the explicit column move last if a rare key rebalance is needed.
    patches.sort(
      (a, b) =>
        Number(ticketEntryKey(a.entry) === active.id) -
        Number(ticketEntryKey(b.entry) === active.id),
    );
    for (const { entry, sortKey } of patches) {
      const result = await upsert({
        environmentId: entry.environmentId,
        input: {
          id: entry.ticket.id,
          requireExisting: true,
          sortKey,
          ...(ticketEntryKey(entry) === active.id && fromStatus !== targetStatus
            ? { status: targetStatus }
            : {}),
        },
      });
      if (result._tag !== "Success") break;
    }
  };
  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="flex-1 text-sm font-medium">Tickets</h1>
        {!narrow && ids.map((id) => <TicketSyncStatus key={id} environmentId={id} />)}
        {ids.length ? (
          <Button size={narrow ? "touch" : "sm"} onClick={() => openTicketCapture()}>
            New ticket
          </Button>
        ) : null}
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        <WorkspacePageContainer width="expanded">
          {ids.length === 0 ? (
            <div className="py-12 text-center">
              <h2 className="text-lg font-medium">Tickets are unavailable</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Update a connected T3 server to use tickets.
              </p>
            </div>
          ) : (
            <>
              {narrow ? (
                <div className="flex flex-wrap items-center gap-3">
                  {ids.map((id) => (
                    <TicketSyncStatus key={id} environmentId={id} />
                  ))}
                </div>
              ) : null}
              {narrow ? (
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      size="touch"
                      aria-label="Search tickets"
                      type="search"
                      placeholder="Search tickets…"
                      value={search.search ?? ""}
                      onChange={(event) => setFilters({ search: event.target.value })}
                    />
                  </div>
                  <Button
                    size="touch"
                    variant="outline"
                    aria-expanded={filtersOpen}
                    aria-controls="ticket-filters"
                    onClick={() => setFiltersOpen(!filtersOpen)}
                  >
                    Filters
                  </Button>
                </div>
              ) : null}
              <div
                id="ticket-filters"
                hidden={narrow && !filtersOpen}
                className="flex flex-wrap items-end gap-3 max-[480px]:flex-col max-[480px]:items-stretch"
              >
                <div hidden={narrow} className="min-w-48 flex-1">
                  <Input
                    aria-label="Search tickets"
                    type="search"
                    placeholder="Search tickets…"
                    value={search.search ?? ""}
                    onChange={(event) => setFilters({ search: event.target.value })}
                  />
                </div>
                <TicketPicker
                  label="Environment"
                  value={search.environmentId ?? "all"}
                  options={[
                    { value: "all", label: "All environments" },
                    ...ids.map((id) => ({
                      value: id,
                      label: environments.find((e) => e.environmentId === id)?.label ?? id,
                    })),
                  ]}
                  onChange={(value) =>
                    setFilters({
                      environmentId: value === "all" ? undefined : EnvironmentId.make(value),
                      projectId: undefined,
                      projectEnvironmentId: undefined,
                      unassigned: undefined,
                    })
                  }
                />
                <TicketPicker
                  label="Project"
                  value={
                    search.unassigned
                      ? "none"
                      : search.projectId
                        ? JSON.stringify([
                            search.projectEnvironmentId ?? search.environmentId,
                            search.projectId,
                          ])
                        : "all"
                  }
                  options={[
                    { value: "all", label: "All projects" },
                    { value: "none", label: "No project" },
                    ...projects
                      .filter(
                        (p) =>
                          ids.includes(p.environmentId) &&
                          (!search.environmentId || p.environmentId === search.environmentId),
                      )
                      .map((p) => ({
                        value: JSON.stringify([p.environmentId, p.id]),
                        label: `${p.title}${ids.length > 1 ? ` · ${environments.find((e) => e.environmentId === p.environmentId)?.label ?? p.environmentId}` : ""}`,
                      })),
                  ]}
                  onChange={(value) => {
                    const scope =
                      value === "none" || value === "all"
                        ? null
                        : (JSON.parse(value) as [string, string]);
                    setFilters({
                      projectId: scope ? ProjectId.make(scope[1]) : undefined,
                      projectEnvironmentId: scope ? EnvironmentId.make(scope[0]) : undefined,
                      unassigned: value === "none" ? true : undefined,
                    });
                  }}
                />
                <Button
                  variant="outline"
                  size={narrow ? "touch" : "sm"}
                  onClick={() => setFilters({ showDropped: !search.showDropped })}
                >
                  {search.showDropped ? "Hide dropped" : "Show dropped"}
                </Button>
                <Button
                  variant="outline"
                  size={narrow ? "touch" : "sm"}
                  onClick={() => setFilters({ deleted: !search.deleted })}
                >
                  {search.deleted ? "Back to board" : "Recently deleted"}
                </Button>
              </div>
              {errors.map((error) => (
                <p key={error} role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ))}
              {loading ? <p className="text-sm text-muted-foreground">Loading tickets…</p> : null}
              {search.deleted ? (
                ids
                  .filter((id) => !search.environmentId || id === search.environmentId)
                  .map((id) => <DeletedTickets key={id} environmentId={id} search={search} />)
              ) : (
                <DndContext
                  sensors={narrow ? [] : sensors}
                  collisionDetection={(args) => {
                    const hits = pointerWithin(args);
                    const cards = hits.filter(
                      (hit) =>
                        args.droppableContainers.find((container) => container.id === hit.id)?.data
                          .current?.kind === "ticket",
                    );
                    return cards.length ? cards : hits.length ? hits : closestCenter(args);
                  }}
                  onDragEnd={(event) => {
                    void drop(event);
                  }}
                >
                  {narrow ? (
                    <div
                      role="group"
                      aria-label="Ticket status"
                      className="flex gap-0.5 overflow-x-auto pb-1"
                    >
                      {[...TICKET_COLUMNS, ...(search.showDropped ? ["dropped" as const] : [])].map(
                        (status) => (
                          <Button
                            key={status}
                            size="touch-sm"
                            variant={
                              ticketBoardColumns(!!search.showDropped, true, activeStatus)[0] ===
                              status
                                ? "default"
                                : "ghost"
                            }
                            aria-pressed={
                              ticketBoardColumns(!!search.showDropped, true, activeStatus)[0] ===
                              status
                            }
                            onClick={() => setActiveStatus(status)}
                          >
                            {TICKET_STATUS_LABELS[status]}
                          </Button>
                        ),
                      )}
                    </div>
                  ) : null}
                  <div
                    className="grid gap-3"
                    style={{
                      gridTemplateColumns: narrow
                        ? "minmax(0, 1fr)"
                        : `repeat(${search.showDropped ? 6 : 5}, minmax(170px, 1fr))`,
                    }}
                  >
                    {ticketBoardColumns(!!search.showDropped, narrow, activeStatus).map(
                      (status) => (
                        <TicketColumn
                          key={status}
                          status={status}
                          narrow={narrow}
                          entries={groups[status]}
                          showAllDone={search.showAllDone === true}
                          onShowAll={() => setFilters({ showAllDone: !search.showAllDone })}
                          onOpen={open}
                          multipleEnvironments={ids.length > 1}
                        />
                      ),
                    )}
                  </div>
                </DndContext>
              )}
            </>
          )}
        </WorkspacePageContainer>
      </div>
      {selected ? (
        <TicketDetail
          key={ticketEntryKey(selected)}
          entry={selected}
          onClose={() => setFilters({ ticketId: undefined, ticketEnvironmentId: undefined })}
        />
      ) : null}
    </SidebarInset>
  );
}
function TicketColumn({
  status,
  narrow,
  entries,
  showAllDone,
  onShowAll,
  onOpen,
  multipleEnvironments,
}: {
  status: TicketStatus;
  narrow: boolean;
  entries: EnvironmentTicket[];
  showAllDone: boolean;
  onShowAll: () => void;
  onOpen: (entry: EnvironmentTicket) => void;
  multipleEnvironments: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${status}`,
    data: { status },
    disabled: narrow,
  });
  return (
    <section
      ref={setNodeRef}
      aria-label={TICKET_STATUS_LABELS[status]}
      className={`min-w-0 min-h-64 rounded-xl border p-2 ${isOver ? "border-primary bg-accent" : "border-border bg-muted/20"}`}
    >
      <div className="mb-3 flex items-center justify-between gap-1">
        <h2 className="text-sm font-medium">
          {TICKET_STATUS_LABELS[status]}{" "}
          <span className="text-muted-foreground">{entries.length}</span>
        </h2>
        {status === "done" ? (
          <Button size={narrow ? "touch" : "xs"} variant="ghost" onClick={onShowAll}>
            {showAllDone ? "Last 14 days" : "Show all"}
          </Button>
        ) : null}
      </div>
      <SortableContext items={entries.map(ticketEntryKey)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {entries.map((entry) => (
            <TicketCard
              key={ticketEntryKey(entry)}
              entry={entry}
              status={status}
              narrow={narrow}
              onOpen={() => onOpen(entry)}
              multipleEnvironments={multipleEnvironments}
            />
          ))}
        </div>
      </SortableContext>
      {entries.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">No tickets</p>
      ) : null}
    </section>
  );
}
function TicketCard({
  entry,
  status,
  narrow,
  onOpen,
  multipleEnvironments,
}: {
  entry: EnvironmentTicket;
  status: TicketStatus;
  narrow: boolean;
  onOpen: () => void;
  multipleEnvironments: boolean;
}) {
  const canWrite = useTicketWriteAllowed(entry.environmentId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    disabled: narrow || !canWrite,
    id: ticketEntryKey(entry),
    data: { status, kind: "ticket" },
  });
  const project = useProjects().find(
    (p) => p.id === entry.ticket.projectId && p.environmentId === entry.environmentId,
  );
  const environment = useEnvironments().environments.find(
    (e) => e.environmentId === entry.environmentId,
  );
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group min-w-0 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-xs ${isDragging ? "z-10 opacity-60" : ""}`}
    >
      <div className="flex items-center gap-1">
        <div className="min-w-0 overflow-hidden">
          <Badge variant="secondary">
            {project?.title ?? entry.ticket.projectName ?? entry.ticket.projectKey ?? "No project"}
          </Badge>
        </div>
        {status !== entry.ticket.status ? (
          <Tooltip>
            <TooltipTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Moved by linked work" />}
            >
              <ArrowUpRightIcon />
            </TooltipTrigger>
            <TooltipPopup>Moved by linked work</TooltipPopup>
          </Tooltip>
        ) : null}
        <div hidden={narrow} className="ml-auto">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={!canWrite}
            aria-label={`Drag ${entry.ticket.title}`}
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon />
          </Button>
        </div>
      </div>
      {multipleEnvironments ? (
        <span className="text-xs text-muted-foreground">
          {environment?.label ?? entry.environmentId}
        </span>
      ) : null}
      <button
        type="button"
        className="text-left text-sm font-medium wrap-anywhere hover:underline max-[480px]:min-h-11"
        onClick={onOpen}
      >
        {entry.ticket.title}
      </button>
      {entry.ticket.body.trim() ? (
        <p className="line-clamp-2 text-xs text-muted-foreground whitespace-pre-line wrap-anywhere">
          {entry.ticket.body.trim()}
        </p>
      ) : null}
      <TicketMarkers entry={entry} />
      <TicketLinks entry={entry} />
      <div className="flex flex-wrap items-center justify-between gap-1">
        <TicketActions entry={entry} />
        <div className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <TicketStartWork entry={entry} />
        </div>
      </div>
    </article>
  );
}
function DeletedTickets({
  environmentId,
  search,
}: {
  environmentId: EnvironmentId;
  search: TicketsSearch;
}) {
  const [now] = useState(() => Date.now());
  const narrow = useMediaQuery("(max-width: 480px)");
  const canWrite = useTicketWriteAllowed(environmentId);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const query = useEnvironmentQuery(
    ticketEnvironment.listTickets({ environmentId, input: { includeDeleted: true } }),
  );
  const restore = useAtomCommand(ticketEnvironment.restoreTicket);
  const [restored, setRestored] = useState<Set<TicketId>>(new Set());
  const groups = groupTicketBoard(
    (query.data?.tickets ?? [])
      .filter((t) => !restored.has(t.id))
      .map((ticket) => ({ environmentId, ticket })),
    {
      ...search,
      projectId: search.unassigned ? "none" : search.projectId,
      projectExists: (env, id) => projects.some((p) => p.environmentId === env && p.id === id),
      deleted: true,
      threadById: () => undefined,
      now,
    },
  );
  const deleted = Object.values(groups)
    .flat()
    .sort((a, b) => b.ticket.deletedAt!.localeCompare(a.ticket.deletedAt!));
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">
        Recently deleted ·{" "}
        {environments.find((e) => e.environmentId === environmentId)?.label ?? environmentId}
      </h2>
      {query.error ? <p role="alert">{query.error}</p> : null}
      <Button size={narrow ? "touch" : "sm"} variant="outline" onClick={query.refresh}>
        Refresh
      </Button>
      {!query.data ? (
        <p className="text-sm text-muted-foreground">Loading deleted tickets…</p>
      ) : deleted.length === 0 ? (
        <p className="text-sm text-muted-foreground">No deleted tickets.</p>
      ) : null}
      {deleted.map((entry) => (
        <div
          key={entry.ticket.id}
          className="flex items-center justify-between gap-3 rounded-lg border p-3"
        >
          <span>{entry.ticket.title}</span>
          <Button
            size={narrow ? "touch" : "sm"}
            variant="outline"
            disabled={!canWrite}
            onClick={() => {
              void restore({ environmentId, input: { id: entry.ticket.id } }).then((result) => {
                if (result._tag === "Success") {
                  setRestored((old) => new Set([...old, entry.ticket.id]));
                  query.refresh();
                }
              });
            }}
          >
            Restore
          </Button>
        </div>
      ))}
    </section>
  );
}
