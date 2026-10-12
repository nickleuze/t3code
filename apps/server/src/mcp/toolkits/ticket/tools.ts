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
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
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
    "File a ticket in the user's backlog for worthwhile follow-up work outside your current task. Project defaults to the calling thread's project, or unassigned for an outside client; pass null for unassigned. Status defaults to inbox. Records this thread as the origin, without marking it as work. Reuse clientRequestId when retrying a creation to avoid duplicates, and mention filed tickets in your reply.",
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
    'List compact backlog rows with explicit stage. Project defaults to the calling thread\'s project, or unassigned for an outside client; pass projectId="all" for every project, or null for unassigned. By default excludes done/dropped; includeDone=true includes them, and an explicit status filter also selects terminal tickets. Query matches title and body. Limit defaults to 50 (maximum 100); hasMore reports additional matches. Returns short body excerpts and up to 10 linked work threads per ticket.',
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
    "Patch an existing ticket's title, body, status or project. Omitted fields are preserved; an empty body clears it and null projectId unassigns it. Explicit status writes a stage event. Activity never changes the stage.",
  parameters: Schema.Struct({ id: TicketId, ...editable }),
  success: TicketSummary,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const LinkThreadTool = Tool.make("t3_ticket_link_thread", {
  ...shared,
  description:
    'Link a ticket to a thread, defaulting to the calling thread (outside clients must pass threadId). Role defaults to "work", which contributes to automatic status; "origin" only records where an idea came from. Set unlink=true to remove the link. The target thread must run within the caller\'s permission modes. Returns the ticket summary with derived status.',
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
    "Read the ticket before working: current state, decisions, questions, last handoff and recent timeline (last 30 events).",
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
    "Write a milestone entry. End handoffs with Next: (or next). Reuse clientRequestId after a lost response; it is deduplicated within your caller namespace.",
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
    "Attach a thread, goal, task or PR to a ticket. Thread ref defaults to the calling thread. Linking alone does not move the stage, but the next run in a work-linked thread moves an Inbox or Ready ticket to In progress. Role defaults to work.",
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
export const TicketToolkit = Toolkit.make(
  CreateTool,
  ListTool,
  UpdateTool,
  LinkThreadTool,
  GetTool,
  EntryTool,
  LinkTool,
);
