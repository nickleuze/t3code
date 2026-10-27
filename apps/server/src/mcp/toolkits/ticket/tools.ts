import {
  OrchestratorMcpFailure,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  TicketId,
  Ticket,
  TicketEvent,
  TicketAuthor,
  TicketEntryKind,
  TicketReferenceKind,
  TicketLinkRole,
  TicketStatus,
  TicketStartMode,
  TicketStartResult,
  ModelSelection,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Launches from "../../../tickets/TicketLaunchService.ts";
import * as Tickets from "../../../tickets/TicketService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    ProjectStore.ProjectStoreV2,
    Tickets.TicketService,
  ],
};

const TicketSummary = Schema.Struct({
  id: TicketId,
  // Derived `<projectKey>-<suffix>` Ticket ID; null for Ideas with no project.
  readableId: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.String,
  status: TicketStatus,
  project: Schema.NullOr(Schema.Struct({ id: ProjectId, title: Schema.NullOr(Schema.String) })),
});

const editable = {
  title: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.String),
  status: Schema.optional(TicketStatus),
  projectKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
};

const CreateTool = Tool.make("t3_ticket_create", {
  ...shared,
  dependencies: [...shared.dependencies, Crypto.Crypto],
  description:
    "File follow-up work outside your task in the user's backlog. `projectId` defaults to this thread's project (outside clients: unassigned); null unassigns. Status defaults to inbox. Links this thread as origin, not work. Reuse `clientRequestId` on retry. Mention filed tickets in your reply.",
  parameters: Schema.Struct({
    ...editable,
    title: TrimmedNonEmptyString,
    clientRequestId: Schema.optional(TrimmedNonEmptyString),
  }),
  success: TicketSummary,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const ListTool = Tool.make("t3_ticket_list", {
  ...shared,
  description:
    'List backlog rows with stage, body excerpt and up to 10 work threads. `projectId` defaults to this thread\'s project (outside clients: unassigned); "all" for every project, null for unassigned. Done/dropped only with `includeDone` or an explicit `status`. `query` matches title and body. `limit` 50 by default, max 100; `hasMore` flags more.',
  parameters: Schema.Struct({
    projectId: Schema.optional(Schema.Union([ProjectId, Schema.Literal("all"), Schema.Null])),
    status: Schema.optional(TicketStatus),
    query: Schema.optional(Schema.String),
    includeDone: Schema.optional(Schema.Boolean),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    tickets: Schema.Array(
      Schema.Struct({
        ...TicketSummary.fields,
        bodyExcerpt: Schema.String,
        githubIssue: Schema.NullOr(
          Schema.Struct({ url: Schema.String, state: Schema.Literals(["open", "closed"]) }),
        ),
        workThreads: Schema.Array(
          Schema.Struct({
            id: ThreadId,
            title: Schema.NullOr(Schema.String),
            status: Schema.NullOr(OrchestrationV2ThreadShell.fields.status),
          }),
        ),
        workThreadsOmitted: Schema.Number,
      }),
    ),
    hasMore: Schema.Boolean,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const UpdateTool = Tool.make("t3_ticket_update", {
  ...shared,
  description:
    "Patch a ticket's title, body, status or project. Omitted fields stay; an empty body clears it; null `projectId` unassigns. An explicit status writes a stage event. Linked work and its PRs move stages on their own; merges never complete a ticket. Leave results In review until the user accepts the finish condition; Done records that acceptance.",
  parameters: Schema.Struct({ id: TicketId, ...editable }),
  success: TicketSummary,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const LinkThreadTool = Tool.make("t3_ticket_link_thread", {
  ...shared,
  description:
    'Link a ticket to a thread, this thread by default (outside clients pass `threadId`). Role "work" by default; "origin" only records where the idea came from. Linking alone does not change stage. `unlink: true` removes it. The thread must run within your permission modes.',
  parameters: Schema.Struct({
    id: TicketId,
    threadId: Schema.optional(ThreadId),
    role: Schema.optional(TicketLinkRole),
    unlink: Schema.optional(Schema.Boolean),
  }),
  success: TicketSummary,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const GetTool = Tool.make("t3_ticket_get", {
  ...shared,
  description:
    "Read a ticket before working on it: state, decisions, questions, last handoff and its last 30 events. Takes the ULID or readable id (e.g. lighting-director-4K7QXM).",
  parameters: Schema.Struct({ ticket: TicketId }),
  success: Schema.Struct({
    ticket: Ticket,
    stageBy: TicketAuthor,
    timeline: Schema.Array(TicketEvent),
    timelineOmitted: Schema.Int,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EntryTool = Tool.make("t3_ticket_entry", {
  ...shared,
  description:
    "Write a milestone entry before your final answer when permitted. Put the next action or needed decision in `next`. Record corrected premises and accepted scope or finish conditions as decisions with their source; `supersedes`/`resolves` keep history. A planning decision does not authorize implementation. Respect plan/read-only modes. Reuse `clientRequestId` on retry. A fallback handoff request needs at most a one-line acknowledgment.",
  parameters: Schema.Struct({
    ticket: TicketId,
    kind: TicketEntryKind,
    text: TrimmedNonEmptyString,
    next: Schema.optional(Schema.String),
    supersedes: Schema.optional(Schema.String),
    resolves: Schema.optional(Schema.String),
    clientRequestId: TrimmedNonEmptyString,
  }),
  success: TicketSummary,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const LinkTool = Tool.make("t3_ticket_link", {
  ...shared,
  description:
    "Attach a thread (this one by default), goal, task or PR to a ticket, role work by default. The next run in a work-linked thread moves an Inbox or Ready ticket to In progress.",
  parameters: Schema.Struct({
    ticket: TicketId,
    kind: TicketReferenceKind,
    ref: Schema.optional(TrimmedNonEmptyString),
    title: Schema.optional(TrimmedNonEmptyString),
    role: Schema.optional(TicketLinkRole),
  }),
  success: TicketSummary,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const StartTool = Tool.make("t3_ticket_start", {
  ...shared,
  dependencies: [...shared.dependencies, Crypto.Crypto, Launches.TicketLaunchService],
  description:
    "Start or hand off work on a ticket, instead of `t3_thread_launch` plus `t3_ticket_link`. Plan first with this machine's project defaults unless set. `projectId` only maps a missing project. Active work returns its thread unless `allowParallel`. Reuse `clientRequestId` on retry. Modes stay within yours.",
  parameters: Schema.Struct({
    ticket: TicketId,
    mode: Schema.optional(TicketStartMode),
    projectId: Schema.optional(ProjectId),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    allowParallel: Schema.optional(Schema.Boolean),
    clientRequestId: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ ...TicketStartResult.fields, threadUrl: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const ProjectMapTool = Tool.make("t3_ticket_project_map", {
  ...shared,
  description:
    "Map a ticket project key to a T3 project on this machine, e.g. after a Project Home folder moved. Tickets keep their key and readable ids; new tickets from that project reuse it. null `projectId` unmaps; no `displayName` keeps the synced name. Per machine. Returns every key and its mapping.",
  parameters: Schema.Struct({
    key: TrimmedNonEmptyString,
    projectId: Schema.NullOr(ProjectId),
    displayName: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        displayName: Schema.String,
        projectId: Schema.NullOr(ProjectId),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
export const TicketToolkit = Toolkit.make(
  StartTool,
  CreateTool,
  ListTool,
  UpdateTool,
  LinkThreadTool,
  GetTool,
  EntryTool,
  LinkTool,
  ProjectMapTool,
);
