import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TicketId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const TicketStatus = Schema.Literals([
  "inbox",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "dropped",
]);
export type TicketStatus = typeof TicketStatus.Type;

export const TicketLinkRole = Schema.Literals(["work", "origin", "planning", "review"]);
export type TicketLinkRole = typeof TicketLinkRole.Type;

export const TicketLink = Schema.Struct({
  threadId: ThreadId,
  machine: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  machineLabel: Schema.optional(Schema.String),
  role: TicketLinkRole,
  linkedAt: IsoDateTime,
});
export type TicketLink = typeof TicketLink.Type;

export const TicketGithubIssue = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  url: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed"]),
  closedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  syncedAt: IsoDateTime,
});
export type TicketGithubIssue = typeof TicketGithubIssue.Type;

const TicketCreatedBy = Schema.Literals(["user", "agent"]);
const TicketCreationSource = Schema.Literals(["web", "mobile", "mcp", "github"]);

export const Ticket = Schema.Struct({
  id: TicketId,
  projectKey: Schema.optional(Schema.NullOr(Schema.String)),
  projectName: Schema.optional(Schema.NullOr(Schema.String)),
  record: Schema.optional(Schema.Boolean),
  workState: Schema.optional(
    Schema.Struct({
      decisions: Schema.Array(Schema.Struct({ eventId: Schema.String, text: Schema.String })),
      questions: Schema.Array(Schema.Struct({ eventId: Schema.String, text: Schema.String })),
      lastHandoff: Schema.NullOr(
        Schema.Struct({ text: Schema.String, next: Schema.optional(Schema.String) }),
      ),
      prs: Schema.Array(Schema.String),
      blocked: Schema.Boolean,
      resultReady: Schema.optional(Schema.Boolean),
    }),
  ),
  projectId: Schema.NullOr(ProjectId),
  title: TrimmedNonEmptyString,
  body: Schema.String,
  status: TicketStatus,
  statusSetAt: IsoDateTime,
  sortKey: Schema.Number.check(Schema.isFinite()),
  createdBy: TicketCreatedBy,
  creationSource: TicketCreationSource,
  originThreadId: Schema.NullOr(ThreadId),
  githubIssue: Schema.NullOr(TicketGithubIssue),
  links: Schema.Array(TicketLink),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Ticket = typeof Ticket.Type;

export const TicketListInput = Schema.Struct({
  includeDeleted: Schema.optional(Schema.Boolean),
});
export type TicketListInput = typeof TicketListInput.Type;

export const TicketListResult = Schema.Struct({ tickets: ForwardCompatibleArray(Ticket) });
export type TicketListResult = typeof TicketListResult.Type;

// Subscription snapshots always exclude deleted tickets.
export const TicketSubscribeInput = Schema.Struct({});
export type TicketSubscribeInput = typeof TicketSubscribeInput.Type;

export const TicketUpsertInput = Schema.Struct({
  id: Schema.optional(TicketId),
  requireExisting: Schema.optional(Schema.Boolean),
  commandId: Schema.optional(CommandId),
  // Creates require a title; updates only change provided editable fields.
  projectKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  title: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.String),
  // Explicit status records a manual override, even if it equals the stored status.
  status: Schema.optional(TicketStatus),
  sortKey: Schema.optional(Schema.Number.check(Schema.isFinite())),
  createdBy: Schema.optional(TicketCreatedBy),
  creationSource: Schema.optional(TicketCreationSource),
  originThreadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type TicketUpsertInput = typeof TicketUpsertInput.Type;

export const TicketDeleteInput = Schema.Struct({ id: TicketId });
export type TicketDeleteInput = typeof TicketDeleteInput.Type;
export const TicketRestoreInput = Schema.Struct({ id: TicketId });
export type TicketRestoreInput = typeof TicketRestoreInput.Type;
export const TicketLinkInput = Schema.Struct({
  id: TicketId,
  threadId: ThreadId,
  role: TicketLinkRole,
  startWork: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.String),
});
export type TicketLinkInput = typeof TicketLinkInput.Type;
export const TicketUnlinkInput = Schema.Struct({ id: TicketId, threadId: ThreadId });
export type TicketUnlinkInput = typeof TicketUnlinkInput.Type;

export const TicketMutationResult = Schema.Struct({ ticket: Ticket });
export type TicketMutationResult = typeof TicketMutationResult.Type;
export const TicketDeleteResult = Schema.Struct({ id: TicketId });
export type TicketDeleteResult = typeof TicketDeleteResult.Type;

export class TicketError extends Schema.TaggedError<TicketError>()("TicketError", {
  message: Schema.String,
  reason: Schema.optional(Schema.Literal("not_found")),
  ticketId: Schema.optional(TicketId),
  cause: Schema.optional(Schema.Defect()),
}) {}

export const TicketAuthor = Schema.Struct({
  actor: Schema.Literals(["user", "agent"]),
  model: Schema.optional(Schema.String),
  thread: Schema.optional(ThreadId),
  machine: TrimmedNonEmptyString,
});
export type TicketAuthor = typeof TicketAuthor.Type;
export const TicketEntryKind = Schema.Literals([
  "decision",
  "progress",
  "blocker",
  "question",
  "result",
  "handoff",
  "note",
]);
export const TicketReferenceKind = Schema.Literals(["thread", "goal", "task", "pr"]);
const EventBase = {
  eventId: TrimmedNonEmptyString,
  ticketId: TicketId,
  at: IsoDateTime,
  by: TicketAuthor,
};
export const TicketEvent = Schema.Union([
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("created"),
    title: TrimmedNonEmptyString,
    body: Schema.String,
    projectKey: Schema.NullOr(Schema.String),
    source: TicketCreationSource,
    originThread: Schema.NullOr(ThreadId),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("fields"),
    title: Schema.optional(TrimmedNonEmptyString),
    body: Schema.optional(Schema.String),
    projectKey: Schema.optional(Schema.NullOr(Schema.String)),
    sortKey: Schema.optional(Schema.Number.check(Schema.isFinite())),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("stage"),
    stage: TicketStatus,
    reason: Schema.Literals([
      "manual",
      "start_work",
      "pr_linked",
      "pr_merged",
      "accepted",
      "reopen",
      "dropped",
    ]),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literals(["link", "unlink"]),
    kind: TicketReferenceKind,
    ref: TrimmedNonEmptyString,
    role: TicketLinkRole,
    machine: TrimmedNonEmptyString,
    title: Schema.optional(Schema.String),
    machineLabel: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("entry"),
    requestKey: Schema.optional(Schema.String),
    kind: TicketEntryKind,
    text: TrimmedNonEmptyString,
    next: Schema.optional(Schema.String),
    supersedes: Schema.optional(Schema.String),
    resolves: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("auto"),
    observationKey: Schema.optional(Schema.String),
    kind: Schema.Literals([
      "pr_closed",
      "thread_started",
      "thread_settled",
      "needs_input",
      "pr_linked",
      "pr_merged",
      "goal_iteration_done",
      "task_done",
    ]),
    ref: Schema.String,
  }),
  Schema.Struct({ ...EventBase, type: Schema.Literals(["deleted", "restored"]) }),
]);
export type TicketEvent = typeof TicketEvent.Type;
export const TicketTimelineInput = Schema.Struct({ id: TicketId });
export const TicketTimelineResult = Schema.Struct({
  events: Schema.Array(TicketEvent),
  machines: Schema.Record(Schema.String, Schema.String),
});
export type TicketTimelineResult = typeof TicketTimelineResult.Type;
export const TicketEntryInput = Schema.Struct({
  id: TicketId,
  kind: TicketEntryKind,
  text: TrimmedNonEmptyString,
  next: Schema.optional(Schema.String),
  supersedes: Schema.optional(Schema.String),
  resolves: Schema.optional(Schema.String),
  clientRequestId: Schema.optional(TrimmedNonEmptyString),
});
export type TicketEntryInput = typeof TicketEntryInput.Type;
export const TicketSyncStatus = Schema.Struct({
  configured: Schema.Boolean,
  remote: Schema.NullOr(Schema.String),
  lastPullAt: Schema.NullOr(IsoDateTime),
  lastPushAt: Schema.NullOr(IsoDateTime),
  pendingEvents: Schema.Int,
  pendingTicketIds: Schema.optional(Schema.Array(TicketId)),
  lastError: Schema.NullOr(Schema.String),
  machine: Schema.String,
  label: Schema.String,
});
export type TicketSyncStatus = typeof TicketSyncStatus.Type;
export const TicketSyncConfigureInput = Schema.Struct({ remoteUrl: TrimmedNonEmptyString });
export const TicketProjectMapInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  projectId: Schema.NullOr(ProjectId),
  displayName: Schema.optional(TrimmedNonEmptyString),
});
export const TicketProjectsResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      displayName: Schema.String,
      projectId: Schema.NullOr(ProjectId),
      suggestedProjectId: Schema.NullOr(ProjectId),
    }),
  ),
});
export type TicketProjectsResult = typeof TicketProjectsResult.Type;

export const TicketSetupCheck = Schema.Struct({
  clonePresent: Schema.Boolean,
  remoteReachable: Schema.Boolean,
  authOk: Schema.NullOr(Schema.Boolean),
  registryParsed: Schema.Boolean,
  messages: Schema.Array(Schema.String),
});
export type TicketSetupCheck = typeof TicketSetupCheck.Type;
export const TicketMachineLabelInput = Schema.Struct({ label: TrimmedNonEmptyString });

export const TicketActionInput = Schema.Struct({
  id: TicketId,
  action: Schema.Literals(["accept", "drop", "reopen"]),
});
export type TicketActionInput = typeof TicketActionInput.Type;

export const TicketStartMode = Schema.Literals(["plan", "default", "goal"]);
export type TicketStartMode = typeof TicketStartMode.Type;
export const TicketStartInput = Schema.Struct({
  ticketId: TicketId,
  threadId: ThreadId,
  commandId: CommandId,
  mode: Schema.optional(TicketStartMode),
  projectId: Schema.optional(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  allowParallel: Schema.optional(Schema.Boolean),
  creationSource: OrchestrationV2CreationSource,
});
export type TicketStartInput = typeof TicketStartInput.Type;
export const TicketStartResult = Schema.Struct({
  status: Schema.Literals(["launched", "already_active"]),
  threadId: ThreadId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  interactionMode: ProviderInteractionMode,
});
export type TicketStartResult = typeof TicketStartResult.Type;
export class TicketNotFound extends Schema.TaggedError<TicketNotFound>()("TicketNotFound", {
  ticketId: TicketId,
}) {
  override get message() {
    return "Ticket not found on this machine.";
  }
}
export class TicketLaunchNeedsProject extends Schema.TaggedError<TicketLaunchNeedsProject>()(
  "TicketLaunchNeedsProject",
  {
    ticketId: TicketId,
  },
) {
  override get message() {
    return "Choose a project on this machine.";
  }
}
export class TicketLaunchError extends Schema.TaggedError<TicketLaunchError>()(
  "TicketLaunchError",
  {
    ticketId: TicketId,
    operation: Schema.Literals([
      "resolve-project",
      "resolve-model",
      "read-thread",
      "launch",
      "goal",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Ticket launch failed during ${this.operation}.`;
  }
}
