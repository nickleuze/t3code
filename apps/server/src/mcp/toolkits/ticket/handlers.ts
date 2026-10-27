import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type Ticket,
  type TicketError,
  ThreadId,
} from "@t3tools/contracts";
import { deriveTicketStatus } from "@t3tools/shared/ticket";
import * as Effect from "effect/Effect";

import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as Launches from "../../../tickets/TicketLaunchService.ts";
import * as Tickets from "../../../tickets/TicketService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, unavailable } from "../../threadAccess.ts";
import { TicketToolkit } from "./tools.ts";

const ticketFailure = (error: TicketError) =>
  error.cause === undefined
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : unavailable();

const excerpt = (value: string, max: number) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const summaries = Effect.fn("mcp.ticketSummaries")(function* (tickets: ReadonlyArray<Ticket>) {
  const { threads } = yield* readCaller();
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectIds = [...new Set(tickets.flatMap((ticket) => ticket.projectId ?? []))];
  const projectRows =
    projectIds.length === 0
      ? []
      : yield* projects.list({ projectIds }).pipe(Effect.mapError(unavailable));
  const projectsById = new Map(projectRows.map((project) => [project.projectId, project]));
  const workThreadIds = [
    ...new Set(
      tickets.flatMap((ticket) =>
        ticket.links.filter((link) => link.role === "work").map((link) => link.threadId),
      ),
    ),
  ];
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  yield* Effect.forEach(
    workThreadIds,
    (id) =>
      threads.getThreadShell(id).pipe(
        Effect.mapError(unavailable),
        Effect.tap((shell) => {
          if (shell !== null && shell.deletedAt === null) shells.set(id, shell);
          return Effect.void;
        }),
      ),
    { concurrency: 8, discard: true },
  );
  return tickets.map((ticket) => ({
    id: ticket.id,
    readableId: ticket.readableId ?? null,
    title: excerpt(ticket.title, 200),
    status: deriveTicketStatus(ticket, (id) => shells.get(id)),
    project:
      ticket.projectId === null
        ? null
        : {
            id: ticket.projectId,
            title: projectsById.has(ticket.projectId)
              ? excerpt(projectsById.get(ticket.projectId)!.title, 200)
              : null,
          },
    bodyExcerpt: excerpt(ticket.body, 160),
    githubIssue:
      ticket.githubIssue === null
        ? null
        : { url: ticket.githubIssue.url, state: ticket.githubIssue.state },
    workThreads: ticket.links
      .filter((link) => link.role === "work")
      .slice(0, 10)
      .map(({ threadId }) => ({
        id: threadId,
        title: shells.has(threadId) ? excerpt(shells.get(threadId)!.title, 200) : null,
        status: shells.get(threadId)?.status ?? null,
      })),
    workThreadsOmitted: Math.max(
      0,
      ticket.links.filter((link) => link.role === "work").length - 10,
    ),
  }));
});

const summary = Effect.fn("mcp.ticketSummary")(function* (ticket: Ticket) {
  const [row] = yield* summaries([ticket]);
  return {
    id: ticket.id,
    readableId: row!.readableId,
    title: ticket.title,
    status: row!.status,
    project: row!.project,
  };
});

export const layer = McpToolAccess.toLayer(TicketToolkit, {
  t3_ticket_start: McpToolAccess.startsThreads(
    (input) => ({
      runtimeMode: input.runtimeMode,
      interactionMode: input.mode === undefined || input.mode === "plan" ? "plan" : "default",
    }),
    (input, limits) =>
      Effect.gen(function* () {
        const { scope, caller } = yield* readCaller();
        const tickets = yield* Tickets.TicketService;
        const launches = yield* Launches.TicketLaunchService;
        const commandId =
          input.clientRequestId === undefined
            ? yield* newCommandId()
            : CommandId.make(
                `mcp:${encodeURIComponent(scope.requestNamespace)}:ticket-start:${encodeURIComponent(input.clientRequestId)}`,
              );
        const { ticket, clientRequestId: _requestId, ...fields } = input;
        const result = yield* launches
          .start(
            {
              ...fields,
              ticketId: ticket,
              commandId,
              threadId: ThreadId.make(commandId),
              creationSource: "mcp",
            },
            {
              limits,
              by: tickets.author({
                actor: "agent",
                ...(caller ? { thread: caller.id, model: caller.modelSelection.model } : {}),
              }),
            },
          )
          .pipe(
            Effect.mapError((error) =>
              error._tag === "OrchestratorMcpFailure"
                ? error
                : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
            ),
          );
        return { ...result, threadUrl: `t3-thread://v1/${result.threadId}` };
      }),
    // Ticket launches do not carry a link's origin, so a linked caller cannot own them.
    { refused: "start ticket work in this environment" },
  ),
  t3_ticket_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.TicketService;
      const state = yield* tickets.get(input.ticket).pipe(Effect.mapError(ticketFailure));
      const { events } = yield* tickets
        .timeline({ id: input.ticket })
        .pipe(Effect.mapError(ticketFailure));
      return {
        ticket: state.ticket,
        stageBy: state.stageBy,
        timeline: events.slice(-30),
        timelineOmitted: Math.max(0, events.length - 30),
      };
    }),
  ),
  t3_ticket_entry: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* readCaller();
      const tickets = yield* Tickets.TicketService;
      const { ticket: id, ...fields } = input;
      const { ticket } = yield* tickets
        .entry(
          { id, ...fields },
          tickets.author({
            actor: "agent",
            ...(caller ? { thread: caller.id, model: caller.modelSelection.model } : {}),
          }),
          scope.requestNamespace,
        )
        .pipe(Effect.mapError(ticketFailure));
      return yield* summary(ticket);
    }),
  ),
  t3_ticket_link: McpToolAccess.writesThreads(
    (input) => (input.kind === "thread" && input.ref ? [ThreadId.make(input.ref)] : []),
    (input) =>
      Effect.gen(function* () {
        const { scope, caller } = yield* readCaller();
        const tickets = yield* Tickets.TicketService;
        const ref = input.ref ?? (input.kind === "thread" ? scope.thread?.threadId : undefined);
        if (!ref)
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass ref for this link.",
          });
        const { ticket } = yield* tickets
          .reference(
            { id: input.ticket, kind: input.kind, ref, role: input.role, title: input.title },
            tickets.author({
              actor: "agent",
              ...(caller ? { thread: caller.id, model: caller.modelSelection.model } : {}),
            }),
          )
          .pipe(Effect.mapError(ticketFailure));
        return yield* summary(ticket);
      }),
  ),
  t3_ticket_create: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* readCaller();
      const tickets = yield* Tickets.TicketService;
      // MCP exposes no stable call id; use the same caller-scoped retry key as other T3 tools.
      const commandId =
        input.clientRequestId === undefined
          ? yield* newCommandId()
          : CommandId.make(
              `mcp:${encodeURIComponent(scope.requestNamespace)}:ticket-create:${encodeURIComponent(input.clientRequestId)}`,
            );
      const { ticket } = yield* tickets
        .upsert(
          {
            ...input,
            commandId,
            projectId:
              input.projectId === undefined ? (caller?.projectId ?? null) : input.projectId,
            createdBy: "agent",
            creationSource: "mcp",
            originThreadId: caller?.id ?? null,
          },
          tickets.author({
            actor: "agent",
            ...(caller ? { thread: caller.id, model: caller.modelSelection.model } : {}),
          }),
        )
        .pipe(Effect.mapError(ticketFailure));
      return yield* summary(ticket);
    }),
  ),
  t3_ticket_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const tickets = yield* Tickets.TicketService;
      const projectId =
        input.projectId === undefined ? (caller?.projectId ?? "all") : input.projectId;
      const query = input.query?.trim().toLowerCase() ?? "";
      const result = yield* tickets.list().pipe(Effect.mapError(ticketFailure));
      const candidates = result.tickets.filter(
        (ticket) =>
          ticket.deletedAt === null &&
          (projectId === "all" || ticket.projectId === projectId) &&
          (query === "" || `${ticket.title}\n${ticket.body}`.toLowerCase().includes(query)),
      );
      const rows = (yield* summaries(candidates)).filter((row) =>
        input.status !== undefined
          ? row.status === input.status
          : input.includeDone === true || (row.status !== "done" && row.status !== "dropped"),
      );
      const limit = input.limit ?? 50;
      return { tickets: rows.slice(0, limit), hasMore: rows.length > limit };
    }),
  ),
  t3_ticket_update: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const tickets = yield* Tickets.TicketService;
      const { ticket } = yield* tickets
        .upsert(
          { ...input, requireExisting: true },
          tickets.author({
            actor: "agent",
            ...(caller ? { thread: caller.id, model: caller.modelSelection.model } : {}),
          }),
        )
        .pipe(Effect.mapError(ticketFailure));
      return yield* summary(ticket);
    }),
  ),
  t3_ticket_project_map: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.TicketService;
      const { projects } = yield* tickets.projectsMap(input).pipe(Effect.mapError(ticketFailure));
      return {
        projects: projects.map(({ key, displayName, projectId }) => ({
          key,
          displayName,
          projectId,
        })),
      };
    }),
  ),
  t3_ticket_link_thread: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { scope, threads, caller } = yield* readCaller();
        const tickets = yield* Tickets.TicketService;
        const threadId = input.threadId ?? scope.thread?.threadId;
        if (threadId === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId: this MCP client is not running inside a T3 thread.",
          });
        const target = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
        // Unlink still works after a linked thread was deleted.
        if (input.unlink !== true && (target === null || target.deletedAt !== null))
          return yield* new OrchestratorMcpFailure({
            code: "thread_not_found",
            message: "The thread was not found.",
          });
        const { ticket } = yield* (
          input.unlink === true
            ? tickets.unlink(
                { id: input.id, threadId },
                tickets.author({
                  actor: "agent",
                  ...(caller ? { thread: caller.id, model: caller.modelSelection.model } : {}),
                }),
              )
            : tickets.link(
                { id: input.id, threadId, role: input.role ?? "work" },
                tickets.author({
                  actor: "agent",
                  ...(caller ? { thread: caller.id, model: caller.modelSelection.model } : {}),
                }),
              )
        ).pipe(Effect.mapError(ticketFailure));
        return yield* summary(ticket);
      }),
  ),
});
