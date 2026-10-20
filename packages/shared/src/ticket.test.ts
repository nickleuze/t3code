import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TicketId, type TicketStatus, type TicketEvent } from "@t3tools/contracts";
import {
  deriveTicketStatus,
  deriveTicketWorkState,
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
  ).toContain("T3 ticket ticket:one: Build tickets\n\nKeep **markdown**.");
  const prompt = ticketStartPrompt({ id: TicketId.make("one"), title: "Title", body: "" });
  expect(prompt).toContain("T3 ticket one: Title\n\nThis is a launch snapshot.");
  expect(prompt).toContain("structured next");
  expect(prompt).toContain("Planning decisions do not grant implementation approval");
  expect(prompt).toContain("do not bypass write restrictions");
  expect(prompt).toContain("before the substantive final answer when permitted");
  expect(prompt).toContain("one-line acknowledgment");
});

it("includes current state and available branch hints in the start prompt", () => {
  const prompt = ticketStartPrompt(
    {
      id: TicketId.make("ticket"),
      title: "Resume",
      body: "Scope",
      workState: {
        decisions: [{ eventId: "d", text: "Keep the native service" }],
        questions: [{ eventId: "q", text: "Which host?" }],
        lastHandoff: { text: "Built slice", next: "Review" },
        prs: ["https://example.test/pr/1"],
        blocked: false,
      },
    },
    ["nick/feat/work", "nick/feat/work"],
  );
  expect(prompt).toContain(
    "Current decisions (recorded scope/corrections; not implementation approval):\n- Keep the native service",
  );
  expect(prompt).toContain("Source: [d; date unavailable; author unavailable]");
  expect(prompt).toContain("Open questions:\n- Which host?");
  expect(prompt).toContain("Next: Review");
  expect(prompt).toContain("Linked branches:\nnick/feat/work");
  expect(prompt).toContain("https://example.test/pr/1");
});

const evidence = (
  n: number,
  kind: Extract<TicketEvent, { type: "entry" }>["kind"],
  extra = {},
): Extract<TicketEvent, { type: "entry" }> => ({
  type: "entry",
  ticketId: TicketId.make("record"),
  eventId: String(n).padStart(5, "0"),
  at: `2026-10-19T10:00:${String(n).padStart(2, "0")}.000Z`,
  by: { actor: "agent", machine: "A", thread: ThreadId.make("work") },
  kind,
  text: `Entry ${n}`,
  ...extra,
});
const stage = (
  n: number,
  value: TicketStatus,
  reason: Extract<TicketEvent, { type: "stage" }>["reason"],
): TicketEvent => ({
  ...evidence(n, "note"),
  type: "stage",
  stage: value,
  reason,
});
describe("shared Ticket evidence", () => {
  it("resolves and supersedes blockers/questions across Runs with deterministic replay", () => {
    const blocked = evidence(1, "blocker");
    const question = evidence(2, "question");
    const resolved = evidence(3, "note", {
      resolves: blocked.eventId,
      by: { actor: "agent", machine: "B" },
    });
    const replacement = evidence(4, "question", { supersedes: question.eventId });
    const events = [blocked, question, resolved, replacement];
    const view = deriveTicketWorkState(events, "in_progress");
    expect(view.blockers).toEqual([]);
    expect(view.questions).toEqual([replacement]);
    expect(view.currentEvidence).toEqual(replacement);
    expect(deriveTicketWorkState(events.toReversed(), "in_progress")).toEqual(view);
    expect(
      deriveTicketWorkState(
        [blocked, evidence(5, "note", { supersedes: blocked.eventId })],
        "ready",
      ).blockers,
    ).toEqual([]);
  });
  it("keeps unrelated machine blockers and clears a Run's blocker on progress without reviving old ones", () => {
    const local = evidence(1, "blocker");
    const remote = evidence(2, "progress", {
      by: { actor: "agent", machine: "B", thread: ThreadId.make("work") },
    });
    expect(deriveTicketWorkState([local, remote], "in_progress").blockers).toEqual([local]);
    const progress = evidence(3, "progress");
    expect(
      deriveTicketWorkState(
        [local, remote, progress, evidence(4, "note", { supersedes: progress.eventId })],
        "in_progress",
      ).blockers,
    ).toEqual([]);
  });
  it("uses newer evidence instead of a stale handoff and never guesses a next action", () => {
    const handoff = evidence(1, "handoff", { next: "Old next" });
    for (const kind of ["result", "decision", "progress"] as const) {
      const latest = evidence(2, kind);
      const view = deriveTicketWorkState([handoff, latest], "in_review");
      expect(view.currentEvidence).toEqual(latest);
      expect(view.lastHandoff).toBeNull();
      expect(view.currentEvidence?.next).toBeUndefined();
    }
    expect(deriveTicketWorkState([handoff], "in_progress").lastHandoff).toEqual(handoff);
  });
  it("keeps threadless blockers until each is explicitly resolved or superseded", () => {
    const by = { actor: "user" as const, machine: "A" };
    const first = evidence(1, "blocker", { by });
    const second = evidence(2, "blocker", { by });
    const progress = evidence(3, "progress", { by });
    const events = [first, second, progress];
    expect(deriveTicketWorkState(events, "in_progress").blockers).toEqual([first, second]);
    const resolved = [...events, evidence(4, "note", { by, resolves: first.eventId })];
    expect(deriveTicketWorkState(resolved, "in_progress").blockers).toEqual([second]);
    expect(
      deriveTicketWorkState(
        [...resolved, evidence(5, "note", { supersedes: second.eventId })],
        "in_progress",
      ).blockers,
    ).toEqual([]);
  });
  it("acceptance, dropping and explicit/manual reopening retain history but discard old next actions", () => {
    const result = evidence(1, "result", { next: "Accept the old work" });
    for (const [closed, reason] of [
      ["done", "accepted"],
      ["dropped", "dropped"],
    ] as const) {
      const events = [result, stage(2, closed, reason)];
      expect(deriveTicketWorkState(events, closed).currentEvidence).toBeNull();
      for (const reopen of ["reopen", "manual"] as const) {
        const reopened = [...events, stage(3, "ready", reopen)];
        const view = deriveTicketWorkState(reopened, "ready");
        expect(view.currentEvidence).toBeNull();
        expect(view.lastHandoff).toBeNull();
        expect(view.resultReady).toBe(false);
        expect(view.entries).toEqual([result]);
        const fresh = evidence(4, "handoff", { next: "Review the new work" });
        expect(deriveTicketWorkState([...reopened, fresh], "ready").currentEvidence).toEqual(fresh);
      }
    }
  });
  it("a newer Run clears old result readiness; superseded results no longer offer acceptance", () => {
    const result = evidence(1, "result");
    expect(
      deriveTicketWorkState([result, stage(2, "in_progress", "start_work")], "in_progress")
        .resultReady,
    ).toBe(false);
    expect(
      deriveTicketWorkState(
        [result, evidence(3, "progress", { supersedes: result.eventId })],
        "in_review",
      ).resultReady,
    ).toBe(false);
  });
});

it("launch context uses dated current evidence and suppresses historical handoffs when explicitly absent", () => {
  const base = {
    id: TicketId.make("ticket"),
    title: "Scope",
    body: "Brief",
    workState: {
      decisions: [],
      questions: [],
      blocked: false,
      prs: [],
      lastHandoff: { text: "Outdated handoff", next: "Outdated next" },
    },
  };
  const currentEvidence = evidence(2, "result", { next: "Nick reviews" });
  const prompt = ticketStartPrompt({ ...base, workState: { ...base.workState, currentEvidence } });
  expect(prompt).toContain("Current evidence (result, 2026-10-19T10:00:02.000Z)");
  expect(prompt).toContain("Next: Nick reviews");
  expect(prompt).not.toContain("Outdated");
  expect(
    ticketStartPrompt({ ...base, workState: { ...base.workState, currentEvidence: null } }),
  ).not.toContain("Outdated");
  expect(ticketStartPrompt(base)).toContain("verify it is still current");
});

it("keeps next action provenance through a question and answer, and through launch", () => {
  const handoff = evidence(1, "handoff", { next: "Implement the selected option" });
  const question = evidence(2, "question");
  const answer = evidence(3, "note", { resolves: question.eventId, text: "Answer: use A" });
  const events = [handoff, question, answer, stage(4, "in_progress", "start_work")];
  const view = deriveTicketWorkState(events, "in_progress");
  expect(view.currentEvidence).toEqual(answer);
  expect(view.nextAction).toEqual({
    eventId: handoff.eventId,
    at: handoff.at,
    by: handoff.by,
    text: handoff.next,
  });
  expect(view.lastHandoff).toEqual(handoff);
  for (const kind of ["progress", "result", "decision", "handoff"] as const)
    expect(
      deriveTicketWorkState([...events, evidence(5, kind)], "in_progress").nextAction,
    ).toBeNull();
  expect(
    deriveTicketWorkState([...events, evidence(5, "note", { next: "" })], "in_progress").nextAction,
  ).toBeNull();
});
it("closed and reopened Tickets do not inherit abandoned blockers or questions", () => {
  const blocked = evidence(1, "blocker");
  const question = evidence(2, "question");
  for (const closed of ["done", "dropped"] as const) {
    const events = [blocked, question, stage(3, closed, "manual")];
    expect(deriveTicketWorkState(events, closed).blockers).toEqual([]);
    expect(deriveTicketWorkState(events, closed).questions).toEqual([]);
    const reopened = [...events, stage(4, "ready", "reopen")];
    expect(deriveTicketWorkState(reopened, "ready").blockers).toEqual([]);
    expect(deriveTicketWorkState(reopened, "ready").nextAction).toBeNull();
    expect(
      deriveTicketWorkState([...reopened, evidence(5, "blocker")], "ready").blockers,
    ).toHaveLength(1);
  }
});
