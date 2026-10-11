import * as Schema from "effect/Schema";

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

export const TicketLinkRole = Schema.Literals(["work", "origin"]);
export type TicketLinkRole = typeof TicketLinkRole.Type;

export const TicketLink = Schema.Struct({
  threadId: ThreadId,
  role: TicketLinkRole,
  linkedAt: IsoDateTime,
});
export type TicketLink = typeof TicketLink.Type;

export const TicketGithubIssue = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  url: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed"]),
  syncedAt: IsoDateTime,
});
export type TicketGithubIssue = typeof TicketGithubIssue.Type;

const TicketCreatedBy = Schema.Literals(["user", "agent"]);
const TicketCreationSource = Schema.Literals(["web", "mobile", "mcp", "github"]);

export const Ticket = Schema.Struct({
  id: TicketId,
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
  ticketId: Schema.optional(TicketId),
  cause: Schema.optional(Schema.Defect()),
}) {}
