import { expect, it } from "vite-plus/test";
import { TicketId, ThreadId, type TicketEvent } from "@t3tools/contracts";
import { resumeTicketLinks, ticketTimelineLabel, ticketActivity } from "./ticketRecord.logic";
it("Resume picks the latest available local work/planning thread and excludes other machines and origin", () => {
  const old = ThreadId.make("old"),
    newer = ThreadId.make("new"),
    remote = ThreadId.make("remote"),
    deleted = ThreadId.make("deleted");
  const links = [
    { threadId: old, machine: "B", role: "work" as const, linkedAt: "2026-10-12T01:00:00Z" },
    { threadId: newer, machine: "B", role: "planning" as const, linkedAt: "2026-10-12T02:00:00Z" },
    { threadId: remote, machine: "A", role: "work" as const, linkedAt: "2026-10-12T03:00:00Z" },
    { threadId: deleted, machine: "B", role: "work" as const, linkedAt: "2026-10-12T04:00:00Z" },
    { threadId: remote, machine: "B", role: "origin" as const, linkedAt: "2026-10-12T05:00:00Z" },
  ];
  expect(
    resumeTicketLinks(links, "B", new Set([old, newer, remote])).map((l) => l.threadId),
  ).toEqual([newer, old]);
  expect(resumeTicketLinks(links, "offline", new Set([old, newer, remote]))).toEqual([]);
});
it("timeline maps snapshots, legacy ids, readable automatic trail and results", () => {
  const base = {
    ticketId: TicketId.make("ticket"),
    eventId: "event",
    at: "2026-10-12T00:00:00Z",
    by: { actor: "agent" as const, machine: "A" },
  };
  const link: TicketEvent = {
    ...base,
    type: "link",
    kind: "thread",
    ref: "id",
    role: "work",
    machine: "A",
    title: "Implementation",
    machineLabel: "Mac mini",
  };
  expect(ticketTimelineLabel(link, {})).toBe("Linked thread Implementation on Mac mini");
  expect(
    ticketTimelineLabel({ ...link, title: undefined, machineLabel: undefined }, { A: "MacBook" }),
  ).toBe("Linked thread id on MacBook");
  for (const [kind, label] of [
    ["pr_linked", "PR linked #42"],
    ["pr_merged", "PR merged #42"],
    ["pr_closed", "PR closed without merging #42"],
    ["thread_started", "Thread started"],
    ["task_done", "Delegated task finished"],
  ] as const)
    expect(
      ticketTimelineLabel(
        { ...base, type: "auto", kind, ref: "https://fixture.local/pull/42" },
        {},
      ),
    ).toBe(label);
  expect(ticketTimelineLabel({ ...base, type: "entry", kind: "result", text: "Built" }, {})).toBe(
    "Result ready",
  );
});

it("activity follows live input/runs and record markers without deriving stage", () => {
  const ticket = {
    status: "ready",
    workState: { blocked: false, resultReady: false },
  } as unknown as import("@t3tools/contracts").Ticket;
  expect(ticketActivity(ticket, [])).toBe("Idle");
  expect(
    ticketActivity({ ...ticket, workState: { ...ticket.workState!, resultReady: true } }, []),
  ).toBe("Result ready");
  expect(
    ticketActivity({ ...ticket, workState: { ...ticket.workState!, blocked: true } }, []),
  ).toBe("Blocked");
  expect(ticketActivity(ticket, [{ status: "running", pendingRuntimeRequest: null }])).toBe(
    "Running",
  );
  expect(
    ticketActivity(ticket, [{ status: "waiting", pendingRuntimeRequest: { id: "question" } }]),
  ).toBe("Needs your input");
  expect(ticket.status).toBe("ready");
});
