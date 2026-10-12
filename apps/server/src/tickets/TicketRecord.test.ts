import { describe, expect, it } from "vite-plus/test";
import { TicketId, type TicketEvent } from "@t3tools/contracts";
import { deterministicEventId, projectTicket, ticketIds } from "./TicketRecord.ts";

const id = TicketId.make("01K79000000000000000000000");
const by = { actor: "user" as const, machine: "A" };
const created: TicketEvent = {
  eventId: "01K79000000000000000000001-A",
  ticketId: id,
  by,
  at: "2026-10-12T00:00:00.000Z",
  type: "created",
  title: "Record",
  body: "Body",
  projectKey: "t3",
  source: "web",
  originThread: null,
};
const event = (
  n: number,
  fields: Omit<TicketEvent, "eventId" | "ticketId" | "by" | "at">,
): TicketEvent =>
  ({
    ...created,
    eventId: `01K790000000000000000000${String(n).padStart(2, "0")}-A`,
    at: `2026-10-12T00:00:${String(n).padStart(2, "0")}.000Z`,
    ...fields,
  }) as TicketEvent;

describe("work record projection", () => {
  it("rebuilds deterministic current state independent of import order", () => {
    const events: TicketEvent[] = [
      created,
      event(2, { type: "fields", title: "Changed" } as Omit<
        TicketEvent,
        "eventId" | "ticketId" | "by" | "at"
      >),
      {
        ...created,
        eventId: "01K79000000000000000000003-B",
        type: "fields",
        title: undefined,
        body: "Concurrent body",
        by: { actor: "agent", machine: "B" },
      },
      event(4, { type: "stage", stage: "ready", reason: "manual" } as Omit<
        TicketEvent,
        "eventId" | "ticketId" | "by" | "at"
      >),
    ];
    expect(projectTicket(events)).toEqual(projectTicket(events.toReversed()));
    expect(projectTicket(events)?.ticket).toMatchObject({
      title: "Changed",
      body: "Concurrent body",
      status: "ready",
    });
  });
  it("never lets start_work move review, done or dropped backwards, including replay", () => {
    for (const stage of ["in_review", "done", "dropped"] as const) {
      const events: TicketEvent[] = [
        created,
        {
          ...created,
          eventId: "01K79000000000000000000002-A",
          type: "stage",
          stage,
          reason: "manual",
        },
        {
          ...created,
          eventId: "01K79000000000000000000003-B",
          type: "stage",
          stage: "in_progress",
          reason: "start_work",
        },
      ];
      expect(projectTicket(events)?.ticket.status).toBe(stage);
    }
  });
  it("manual stage survives importing an older observation later", () => {
    const manual: TicketEvent = {
      ...created,
      eventId: "01K79000000000000000000005-A",
      type: "stage",
      stage: "ready",
      reason: "manual",
    };
    const older: TicketEvent = {
      ...created,
      eventId: "01K79000000000000000000003-B",
      type: "stage",
      stage: "in_progress",
      reason: "start_work",
    };
    expect(projectTicket([created, manual, older])?.ticket.status).toBe("ready");
  });
  it("tracks current decisions, open questions, last handoff and per-thread blocker resolution", () => {
    const entry = (
      n: number,
      kind: "decision" | "question" | "blocker" | "handoff",
      extra = {},
    ): TicketEvent => ({
      ...created,
      eventId: `01K7900000000000000000000${n}-A`,
      type: "entry",
      kind,
      text: `Entry ${n}`,
      ...extra,
    });
    const events: TicketEvent[] = [
      created,
      entry(2, "decision"),
      entry(3, "question"),
      entry(4, "blocker"),
      entry(5, "decision", { supersedes: "01K79000000000000000000002-A" }),
      entry(6, "handoff", { resolves: "01K79000000000000000000003-A", next: "Continue" }),
    ];
    const state = projectTicket(events)!;
    expect(state.decisions.map((e) => e.text)).toEqual(["Entry 5"]);
    expect(state.questions).toEqual([]);
    expect(state.lastHandoff?.next).toBe("Continue");
    expect(state.blocked).toBe(false);
    expect(state.counts.entries).toBe(5);
  });
  it("uses monotonic ULIDs and stable namespaced retry identities", () => {
    const generate = ticketIds();
    const first = generate(100);
    const second = generate(100);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second > first).toBe(true);
    expect(generate(99) > second).toBe(true);
    expect(deterministicEventId("caller", "request", "A")).toBe(
      deterministicEventId("caller", "request", "A"),
    );
    expect(deterministicEventId("other", "request", "A")).not.toBe(
      deterministicEventId("caller", "request", "A"),
    );
  });
});
