import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { Ticket, TicketGithubIssue, TicketListResult, TicketUpsertInput } from "./ticket.ts";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";

const ticket = {
  id: "ticket:one",
  projectId: null,
  title: "Capture",
  body: "",
  status: "inbox",
  statusSetAt: "2026-10-11T00:00:00.000Z",
  sortKey: 0.5,
  createdBy: "user",
  creationSource: "web",
  originThreadId: null,
  githubIssue: null,
  links: [],
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
  deletedAt: null,
};
const decodeTicket = Schema.decodeUnknownSync(Ticket);
const decodeList = Schema.decodeUnknownSync(TicketListResult);
const decodeUpsert = Schema.decodeUnknownSync(TicketUpsertInput);
const isTicket = Schema.is(Ticket);
const capability = Schema.Struct({ tickets: ExecutionEnvironmentCapabilities.fields.tickets });
const decodeCapability = Schema.decodeSync(capability);

describe("ticket contracts", () => {
  it("decodes unassigned tickets and GitHub metadata", () => {
    expect(decodeTicket(ticket)).toEqual(ticket);
    expect(
      decodeTicket({
        ...ticket,
        githubIssue: {
          repository: "nick/t3code",
          number: 42,
          url: "https://github.com/nick/t3code/issues/42",
          state: "closed",
          syncedAt: ticket.updatedAt,
        },
      }).githubIssue?.number,
    ).toBe(42);
  });
  it("skips a future status without losing the list", () => {
    expect(
      decodeList({
        tickets: [ticket, { ...ticket, status: "future" }],
      }).tickets,
    ).toEqual([ticket]);
  });
  it("rejects invalid mutation fields", () => {
    const input = { projectId: null, title: "Title", body: "", sortKey: 1 };
    expect(decodeUpsert(input)).toEqual(input);
    for (const extra of [
      { title: " " },
      { sortKey: Infinity },
      { status: "unknown" },
      { creationSource: "schedule" },
    ]) {
      expect(() => decodeUpsert({ ...input, ...extra })).toThrow();
    }
  });
  it("accepts minimal creates and partial updates without supplying defaults", () => {
    for (const input of [
      { title: "Capture" },
      { id: ticket.id, status: "ready" },
      { id: ticket.id, body: "" },
      { id: ticket.id, projectId: null, sortKey: 0 },
      {}, // Missing create titles are reported by the service as TicketError.
    ]) {
      expect(decodeUpsert(input)).toEqual(input);
    }
  });
  it("keeps the tickets capability optional for older environments", () => {
    expect(decodeCapability({})).toEqual({});
    expect(decodeCapability({ tickets: true })).toEqual({ tickets: true });
    expect(isTicket({ ...ticket, deletedAt: ticket.updatedAt })).toBe(true);
  });
});

it("defaults missing legacy issue close time to null and preserves known close times", () => {
  const issue = {
    repository: "github.com/acme/project",
    number: 1,
    url: "https://github.com/acme/project/issues/1",
    state: "closed" as const,
    syncedAt: ticket.updatedAt,
  };
  const decode = Schema.decodeSync(TicketGithubIssue);
  expect(decode(issue).closedAt).toBeNull();
  expect(decode({ ...issue, closedAt: ticket.updatedAt }).closedAt).toBe(ticket.updatedAt);
});
