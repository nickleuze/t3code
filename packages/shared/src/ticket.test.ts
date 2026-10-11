import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { TicketId, type TicketStatus } from "@t3tools/contracts";
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
    name: "new issue closure advances",
    status: "inbox",
    threads: [],
    issue: { state: "closed", syncedAt: after },
    expected: "done",
  },
  {
    name: "old issue closure ignored",
    status: "ready",
    threads: [],
    issue: { state: "closed", syncedAt: before },
    expected: "ready",
  },
  {
    name: "equal issue closure ignored",
    status: "ready",
    threads: [],
    issue: { state: "closed", syncedAt: at },
    expected: "ready",
  },
  {
    name: "open issue ignored",
    status: "ready",
    threads: [],
    issue: { state: "open", syncedAt: after },
    expected: "ready",
  },
  { name: "done is terminal", status: "done", threads: [thread(after, [after])], expected: "done" },
  {
    name: "dropped is terminal even with a closed issue",
    status: "dropped",
    threads: [thread(after, [after])],
    issue: { state: "closed", syncedAt: after },
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
  it.each(cases)("$name", ({ status, threads, issue, expected }) => {
    const ticket = { status, statusSetAt: at, githubIssue: issue ?? null };
    expect(deriveTicketStatus(ticket, threads)).toBe(expected);
    expect(ticket.status).toBe(status);
  });
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
