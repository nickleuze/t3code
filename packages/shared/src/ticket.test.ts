import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TicketId, type TicketStatus } from "@t3tools/contracts";
import {
  deriveTicketStatus,
  ticketStartPrompt,
  type TicketLinkedThreadShell,
  type TicketStatusInput,
} from "./ticket.ts";

const before = "2026-10-11T10:00:00.000Z";
const at = "2026-10-11T11:00:00.000Z";
const after = "2026-10-11T12:00:00.000Z";
const thread = (run: string | null, prs: string[] = []): TicketLinkedThreadShell => ({
  latestRunStartedAt: run,
  pullRequests: prs.map((linkedAt) => ({ linkedAt })),
});
const cases: {
  name: string;
  status: TicketStatus;
  threads: TicketLinkedThreadShell[];
  issue?: TicketStatusInput["githubIssue"];
  expected: TicketStatus;
}[] = [
  { name: "no signals preserves inbox", status: "inbox", threads: [], expected: "inbox" },
  { name: "optional shell fields are absent", status: "ready", threads: [{}], expected: "ready" },
  {
    name: "decoded DateTime run advances",
    status: "ready",
    threads: [{ latestRunStartedAt: DateTime.makeUnsafe(after) }],
    expected: "in_progress",
  },
  {
    name: "dismissed stack links are ignored",
    status: "ready",
    threads: [{ pullRequests: [{ linkedAt: after, source: "stack-dismissed" }] }],
    expected: "ready",
  },
  { name: "no signals preserves ready", status: "ready", threads: [], expected: "ready" },
  { name: "new run advances", status: "inbox", threads: [thread(after)], expected: "in_progress" },
  {
    name: "new PR advances",
    status: "ready",
    threads: [thread(null, [after])],
    expected: "in_review",
  },
  { name: "old run is ignored", status: "ready", threads: [thread(before)], expected: "ready" },
  { name: "equal run is ignored", status: "ready", threads: [thread(at)], expected: "ready" },
  {
    name: "old PR is ignored",
    status: "ready",
    threads: [thread(null, [before])],
    expected: "ready",
  },
  {
    name: "equal PR is ignored",
    status: "ready",
    threads: [thread(null, [at])],
    expected: "ready",
  },
  {
    name: "takes max across threads",
    status: "inbox",
    threads: [thread(after), thread(null, [after])],
    expected: "in_review",
  },
  {
    name: "run never lowers review",
    status: "in_review",
    threads: [thread(after)],
    expected: "in_review",
  },
  {
    name: "manual move back to ready sticks until a newer signal",
    status: "ready",
    threads: [thread(before, [at])],
    expected: "ready",
  },
  {
    name: "work after manual move advances",
    status: "ready",
    threads: [thread(after, [before])],
    expected: "in_progress",
  },
  {
    name: "issue closed after manual status advances to done",
    status: "inbox",
    threads: [],
    issue: { state: "closed", closedAt: after },
    expected: "done",
  },
  {
    name: "old issue closure ignored",
    status: "ready",
    threads: [],
    issue: { state: "closed", closedAt: before },
    expected: "ready",
  },
  {
    name: "equal issue closure ignored",
    status: "ready",
    threads: [],
    issue: { state: "closed", closedAt: at },
    expected: "ready",
  },
  {
    name: "manual reopen after close sticks across refreshes",
    status: "ready",
    threads: [],
    issue: { state: "closed", closedAt: before },
    expected: "ready",
  },
  {
    name: "legacy closure with unknown close time is ignored",
    status: "ready",
    threads: [],
    issue: { state: "closed" },
    expected: "ready",
  },
  {
    name: "open issue ignored",
    status: "ready",
    threads: [],
    issue: { state: "open", closedAt: after },
    expected: "ready",
  },
  { name: "done is terminal", status: "done", threads: [thread(after, [after])], expected: "done" },
  {
    name: "dropped is terminal even with a closed issue",
    status: "dropped",
    threads: [thread(after, [after])],
    issue: { state: "closed", closedAt: after },
    expected: "dropped",
  },
  {
    name: "compares instants across offsets",
    status: "ready",
    threads: [thread("2026-10-11T14:00:00+02:00")],
    expected: "in_progress",
  },
];
describe("deriveTicketStatus", () => {
  it.each([thread(after), thread(null, [after])])(
    "ignores origin thread work signals: %j",
    (shell) => {
      const ticket = {
        status: "inbox" as const,
        statusSetAt: at,
        githubIssue: null,
        links: [{ threadId: ThreadId.make("origin"), role: "origin" as const, linkedAt: before }],
      };
      expect(deriveTicketStatus(ticket, () => shell)).toBe("inbox");
    },
  );
  it("ignores missing work-linked threads", () => {
    const ticket: TicketStatusInput = {
      status: "inbox",
      statusSetAt: at,
      githubIssue: null,
      links: [{ threadId: ThreadId.make("missing"), role: "work", linkedAt: before }],
    };
    expect(deriveTicketStatus(ticket, () => undefined)).toBe("inbox");
  });
  it("selects work-linked shells by id from mixed origin and work links", () => {
    const originId = ThreadId.make("origin");
    const workId = ThreadId.make("work");
    const ticket: TicketStatusInput = {
      status: "inbox",
      statusSetAt: at,
      githubIssue: null,
      links: [
        { threadId: originId, role: "origin", linkedAt: before },
        { threadId: workId, role: "work", linkedAt: before },
      ],
    };
    const shells = new Map([
      [originId, thread(after, [after])],
      [workId, thread(after)],
    ]);
    expect(deriveTicketStatus(ticket, (id) => shells.get(id))).toBe("in_progress");
  });
  it.each(cases)("$name", ({ status, threads, issue, expected }) => {
    const shells = new Map(threads.map((shell, index) => [ThreadId.make(`work:${index}`), shell]));
    const ticket: TicketStatusInput = {
      status,
      statusSetAt: at,
      githubIssue: issue ?? null,
      links: [...shells.keys()].map((threadId) => ({ threadId, role: "work", linkedAt: before })),
    };
    expect(deriveTicketStatus(ticket, (id) => shells.get(id))).toBe(expected);
    expect(ticket.status).toBe(status);
  });
});
it("refresh timestamps never override a manual reopen after the issue close", () => {
  for (const syncedAt of [at, after, "2026-10-12T12:00:00.000Z"]) {
    const ticket = {
      status: "ready" as const,
      statusSetAt: at,
      links: [],
      githubIssue: { state: "closed" as const, closedAt: before, syncedAt },
    };
    expect(deriveTicketStatus(ticket, () => undefined)).toBe("ready");
  }
});
it("builds a start prompt with markdown body and ticket provenance", () => {
  expect(
    ticketStartPrompt({
      id: TicketId.make("ticket:one"),
      title: "Build tickets",
      body: "Keep **markdown**.",
    }),
  ).toBe("Build tickets\n\nKeep **markdown**.\n\nThis work came from T3 ticket ticket:one.");
  expect(ticketStartPrompt({ id: TicketId.make("one"), title: "Title", body: "" })).toBe(
    "Title\n\nThis work came from T3 ticket one.",
  );
});
