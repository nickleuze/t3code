// @effect-diagnostics nodeBuiltinImport:off -- Synchronous pure ULID/hash helpers are shared with projection fixtures; no runtime service is captured.
import * as NodeCrypto from "node:crypto";
import { TicketId, ThreadId, type Ticket, type TicketEvent } from "@t3tools/contracts";

import { deriveTicketWorkState } from "@t3tools/shared/ticket";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function base32(value: bigint, length: number): string {
  let encoded = "";
  for (let i = 0; i < length; i++) {
    encoded = ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}
// A monotonic ULID generator per service: equal milliseconds keep write order.
export function ticketIds() {
  let lastTime = -1;
  let entropy = 0n;
  return (time: number) => {
    const ms = Math.max(time, lastTime);
    entropy =
      ms === lastTime ? entropy + 1n : BigInt(`0x${NodeCrypto.randomBytes(10).toString("hex")}`);
    lastTime = ms;
    return base32(BigInt(ms), 10) + base32(entropy, 16);
  };
}
export function deterministicEventId(
  namespace: string,
  request: string,
  machine: string,
  time = 0,
): string {
  // Retry entropy is caller-scoped. The first append records its ULID timestamp
  // and requestKey durably in the event, so retries and rebuilds reuse it.
  const hash = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([namespace, request]))
    .digest("hex");
  return `${base32(BigInt(time), 10)}${base32(BigInt(`0x${hash.slice(0, 20)}`), 16)}-${machine}`;
}
export type TicketRecordState = {
  ticket: Ticket;
  stageBy: TicketEvent["by"];
  references: Extract<TicketEvent, { type: "link" | "unlink" }>[];
  decisions: Extract<TicketEvent, { type: "entry" }>[];
  questions: Extract<TicketEvent, { type: "entry" }>[];
  lastHandoff: Extract<TicketEvent, { type: "entry" }> | null;
  blocked: boolean;
  counts: { entries: number; events: number };
};
export function projectTicket(events: readonly TicketEvent[]): TicketRecordState | null {
  const sorted = [...events].sort((a, b) =>
    a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0,
  );
  const created = sorted.find((event) => event.type === "created");
  if (created?.type !== "created") return null;
  const ticket: { -readonly [K in keyof Ticket]: Ticket[K] } = {
    id: created.ticketId,
    title: created.title,
    body: created.body,
    projectKey: created.projectKey,
    projectId: null,
    projectName: null,
    record: true,
    status: "inbox",
    statusSetAt: created.at,
    sortKey: 0,
    createdBy: created.by.actor,
    creationSource: created.source,
    originThreadId: created.originThread,
    githubIssue: null,
    links: [],
    createdAt: created.at,
    updatedAt: created.at,
    deletedAt: null,
  };
  let stageBy = created.by;
  const references = new Map<string, Extract<TicketEvent, { type: "link" | "unlink" }>>();
  const entries: Extract<TicketEvent, { type: "entry" }>[] = [];
  for (const event of sorted) {
    if (event.type === "fields")
      Object.assign(ticket, {
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.body !== undefined ? { body: event.body } : {}),
        ...("projectKey" in event ? { projectKey: event.projectKey } : {}),
        ...(event.sortKey !== undefined ? { sortKey: event.sortKey } : {}),
      });
    if (
      event.type === "stage" &&
      (event.reason !== "start_work" || ticket.status === "inbox" || ticket.status === "ready")
    ) {
      Object.assign(ticket, { status: event.stage, statusSetAt: event.at });
      stageBy = event.by;
    }
    if (event.type === "link" || event.type === "unlink") {
      const key = JSON.stringify([event.kind, event.ref, event.machine]);
      if (event.type === "unlink") references.delete(key);
      else references.set(key, { ...event, at: references.get(key)?.at ?? event.at });
    }
    if (event.type === "entry") entries.push(event);
    if (event.type === "deleted") ticket.deletedAt = event.at;
    if (event.type === "restored") ticket.deletedAt = null;
    if (event.at > ticket.updatedAt) ticket.updatedAt = event.at;
  }
  Object.assign(ticket, {
    links: [...references.values()]
      .filter((e) => e.kind === "thread")
      .map((e) => ({
        threadId: ThreadId.make(e.ref),
        role: e.role,
        linkedAt: e.at,
        machine: e.machine,
        title: e.title,
        machineLabel: e.machineLabel,
      })),
  });
  const {
    decisions,
    answers,
    questions,
    briefSource,
    lastHandoff,
    blockers,
    currentEvidence,
    nextAction,
    resultReady,
  } = deriveTicketWorkState(sorted, ticket.status);
  const blocked = blockers.length > 0;
  Object.assign(ticket, {
    workState: {
      decisions: decisions.map((e) => ({ eventId: e.eventId, text: e.text, at: e.at, by: e.by })),
      answers,
      questions: questions.map((e) => ({ eventId: e.eventId, text: e.text, at: e.at, by: e.by })),
      briefSource,
      lastHandoff,
      blocked,
      resultReady,
      currentEvidence,
      nextAction,
      prs: [...references.values()].filter((e) => e.kind === "pr").map((e) => e.ref),
    },
  });
  return {
    ticket,
    stageBy,
    references: [...references.values()],
    decisions,
    questions,
    lastHandoff,
    blocked,
    counts: { entries: entries.length, events: sorted.length },
  };
}
export function migratedTicketId(legacyId: string, at: string): TicketId {
  const hash = NodeCrypto.createHash("sha256").update(legacyId).digest("hex");
  return TicketId.make(
    base32(BigInt(Math.max(0, Date.parse(at))), 10) + base32(BigInt(`0x${hash.slice(0, 20)}`), 16),
  );
}
