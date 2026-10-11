import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, TicketId, type Ticket } from "@t3tools/contracts";
import {
  groupTicketBoard,
  pendingTicketLinkOnPromotion,
  ticketSortKeyBetween,
  ticketInsertionSortKeys,
  ticketThreadSummary,
  ticketThreadStatus,
} from "./ticketBoard.ts";
import type { EnvironmentThreadShell } from "./models.ts";
const env = EnvironmentId.make("one");
const other = EnvironmentId.make("two");
const threadId = ThreadId.make("work");
const now = Date.parse("2026-10-11T12:00:00Z");
const ticket: Ticket = {
  id: TicketId.make("idea"),
  projectId: null,
  title: "A useful idea",
  body: "Details",
  status: "ready",
  statusSetAt: "2026-10-11T00:00:00Z",
  sortKey: 0,
  createdBy: "user",
  creationSource: "web",
  originThreadId: null,
  githubIssue: null,
  links: [{ threadId, role: "work", linkedAt: "2026-10-11T00:00:00Z" }],
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
  deletedAt: null,
};
const options = {
  now,
  threadById: () => ({
    latestRunStartedAt: "2026-10-11T01:00:00Z",
    pullRequests: [{ linkedAt: "2026-10-11T02:00:00Z" }],
  }),
};
describe("ticket board", () => {
  it("groups by derived status and preserves a later manual override", () => {
    const grouped = groupTicketBoard([{ environmentId: env, ticket }], options);
    expect(grouped.in_review).toHaveLength(1);
    expect(grouped.ready).toHaveLength(0);
    expect(
      groupTicketBoard(
        [{ environmentId: env, ticket: { ...ticket, statusSetAt: "2026-10-11T03:00:00Z" } }],
        options,
      ).ready,
    ).toHaveLength(1);
    expect(
      groupTicketBoard(
        [
          {
            environmentId: env,
            ticket: { ...ticket, links: [{ ...ticket.links[0]!, role: "origin" }] },
          },
        ],
        options,
      ).ready,
    ).toHaveLength(1);
  });
  it("filters environments, projects, search, deleted and terminal history independently", () => {
    const entries = [
      { environmentId: env, ticket },
      {
        environmentId: other,
        ticket: { ...ticket, id: TicketId.make("dropped"), status: "dropped" as const },
      },
      {
        environmentId: env,
        ticket: {
          ...ticket,
          id: TicketId.make("old"),
          status: "done" as const,
          updatedAt: "2026-09-01T00:00:00Z",
        },
      },
      {
        environmentId: env,
        ticket: { ...ticket, id: TicketId.make("deleted"), deletedAt: "2026-10-11T00:00:00Z" },
      },
    ];
    const base = { now, threadById: () => undefined };
    const groups = groupTicketBoard(entries, base);
    expect(
      Object.values(groups)
        .flat()
        .map((e) => e.ticket.id),
    ).toEqual([ticket.id]);
    expect(groupTicketBoard(entries, { ...base, showAllDone: true }).done).toHaveLength(1);
    expect(groupTicketBoard(entries, { ...base, showDropped: true }).dropped).toHaveLength(1);
    expect(
      Object.values(groupTicketBoard(entries, { ...base, deleted: true })).flat(),
    ).toHaveLength(1);
    expect(groupTicketBoard(entries, { ...base, environmentId: other }).ready).toHaveLength(0);
    expect(
      groupTicketBoard(entries, { ...base, projectId: "none", search: "DETAILS" }).ready,
    ).toHaveLength(1);
    expect(groupTicketBoard(entries, { ...base, projectId: "missing" }).ready).toHaveLength(0);
  });
  it("sorts by fractional key with stable environment-scoped ties", () => {
    const entries = [
      { environmentId: other, ticket },
      { environmentId: env, ticket },
      { environmentId: env, ticket: { ...ticket, id: TicketId.make("first"), sortKey: -1 } },
    ];
    expect(
      groupTicketBoard(entries, { now, threadById: () => undefined }).ready.map(
        (e) => `${e.environmentId}:${e.ticket.id}`,
      ),
    ).toEqual(["one:first", "one:idea", "two:idea"]);
  });
  it("scopes identical project ids by environment and treats missing projects as unassigned", () => {
    const projectId = ProjectId.make("shared-project-id");
    const entries = [
      { environmentId: env, ticket: { ...ticket, projectId } },
      { environmentId: other, ticket: { ...ticket, projectId } },
    ];
    const base = { now, threadById: () => undefined };
    expect(
      groupTicketBoard(entries, { ...base, projectId, projectEnvironmentId: env }).ready.map(
        (e) => e.environmentId,
      ),
    ).toEqual([env]);
    expect(
      groupTicketBoard(entries, {
        ...base,
        projectId: "none",
        projectExists: (id) => id === env,
      }).ready.map((e) => e.environmentId),
    ).toEqual([other]);
  });
});
describe("fractional order", () => {
  it("places before, after and between neighbors without changing their order", () => {
    expect(ticketSortKeyBetween()).toBe(0);
    expect(ticketSortKeyBetween(undefined, -3)).toBe(-4);
    expect(ticketSortKeyBetween(4)).toBe(5);
    expect(ticketSortKeyBetween(-4, -2)).toBe(-3);
    const midpoint = ticketSortKeyBetween(0.125, 0.25);
    expect(midpoint).toBeGreaterThan(0.125);
    expect(midpoint).toBeLessThan(0.25);
  });
  it("re-spaces keys only when ties or floating-point exhaustion prevent insertion", () => {
    const source = { environmentId: env, ticket };
    const before = {
      environmentId: env,
      ticket: { ...ticket, id: TicketId.make("before"), sortKey: 1 },
    };
    const after = {
      environmentId: other,
      ticket: { ...ticket, id: TicketId.make("after"), sortKey: 2 },
    };
    expect(ticketInsertionSortKeys([before, after], source, 1)).toEqual([
      { entry: source, sortKey: 1.5 },
    ]);
    for (const key of [1, 1 + Number.EPSILON]) {
      const patches = ticketInsertionSortKeys(
        [before, { ...after, ticket: { ...after.ticket, sortKey: key } }],
        source,
        1,
      );
      expect(patches.map((p) => [p.entry.ticket.id, p.sortKey])).toEqual(
        [
          [before.ticket.id, 0],
          [ticket.id, 1],
          [after.ticket.id, 2],
        ].filter(([id, sortKey]) => id !== after.ticket.id || key !== sortKey),
      );
    }
  });
});
describe("pending draft ticket links", () => {
  it("does not link an abandoned or unacknowledged draft, or a same-id thread in another environment", () => {
    const pending = { environmentId: env, ticketId: ticket.id, threadId };
    expect(pendingTicketLinkOnPromotion(pending, null)).toBeNull();
    expect(pendingTicketLinkOnPromotion(pending, { environmentId: other, threadId })).toBeNull();
    expect(pendingTicketLinkOnPromotion(undefined, { environmentId: env, threadId })).toBeNull();
    expect(pendingTicketLinkOnPromotion(pending, { environmentId: env, threadId })).toEqual({
      environmentId: env,
      input: { id: ticket.id, threadId, role: "work" },
    });
  });
});
describe("work summaries", () => {
  it("tolerates unknown threads and excludes origin links", () => {
    expect(ticketThreadSummary(ticket, () => undefined)[0]?.status).toBe("not started");
    expect(
      ticketThreadSummary(
        { ...ticket, links: [{ ...ticket.links[0]!, role: "origin" }] },
        () => undefined,
      ),
    ).toEqual([]);
  });
  it("prioritizes requests, then running work, settlement and idle", () => {
    const shell = {
      deletedAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: null,
      settledOverride: null,
      settledAt: null,
    } as EnvironmentThreadShell;
    expect(ticketThreadStatus(shell)).toBe("idle");
    expect(ticketThreadStatus({ ...shell, settledAt: "2026-10-11T00:00:00Z" })).toBe("settled");
    expect(
      ticketThreadStatus({
        ...shell,
        runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
      }),
    ).toBe("running");
    expect(ticketThreadStatus({ ...shell, hasPendingUserInput: true })).toBe("needs input");
    expect(ticketThreadStatus({ ...shell, hasActionableProposedPlan: true })).toBe("needs input");
    expect(ticketThreadStatus({ ...shell, deletedAt: "2026-10-11T00:00:00Z" })).toBe("not started");
  });
});
