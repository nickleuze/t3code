// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  TicketId,
  type Ticket,
  type TicketEvent,
  type TicketEntryInput,
} from "@t3tools/contracts";
import { TicketTimeline } from "./TicketTimeline";

const boundary = vi.hoisted(() => ({
  events: [] as TicketEvent[],
  allowed: true,
  fail: false,
  add: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({ events: boundary.events, machines: { A: "MacBook" } }),
  useAtomRefresh: () => boundary.refresh,
}));
vi.mock("../../state/tickets", () => ({
  ticketEnvironment: { timeline: () => ({}), addEntry: {} },
  useTicketWriteAllowed: () => boundary.allowed,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => boundary.add }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("./TicketLinks", () => ({ TicketRecordLinks: () => null }));
vi.mock("./TicketPicker", () => ({
  TicketPicker: ({
    label,
    value,
    options,
    onChange,
    disabled,
  }: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    disabled: boolean;
  }) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const ticket: Ticket = {
  id: TicketId.make("ticket"),
  title: "Scope",
  body: "Scope: fix the view.\nDone when: history is readable.",
  projectId: null,
  status: "in_progress",
  statusSetAt: "2026-10-19T10:00:00Z",
  sortKey: 0,
  createdBy: "user",
  creationSource: "web",
  originThreadId: null,
  githubIssue: null,
  links: [],
  createdAt: "2026-10-19T10:00:00Z",
  updatedAt: "2026-10-19T10:00:00Z",
  deletedAt: null,
};
const event = (
  n: number,
  kind: TicketEntryInput["kind"] = "note",
): Extract<TicketEvent, { type: "entry" }> => ({
  type: "entry",
  ticketId: ticket.id,
  eventId: `entry-${String(n).padStart(3, "0")}`,
  at: new Date(Date.parse(ticket.createdAt) + n * 1000).toISOString(),
  by: { actor: "user", machine: "A" },
  kind,
  text: `Evidence ${n}`,
});
let root: Root;
let container: HTMLDivElement;
const composerRef = createRef<HTMLTextAreaElement>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  boundary.events = [];
  boundary.allowed = true;
  boundary.fail = false;
  boundary.add.mockReset().mockImplementation(async ({ input }: { input: TicketEntryInput }) => {
    if (boundary.fail) return { _tag: "Failure" };
    boundary.events = [...boundary.events, { ...event(200), ...input, type: "entry" }];
    return { _tag: "Success" };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () =>
    root.render(
      <TicketTimeline
        entry={{ environmentId: EnvironmentId.make("local"), ticket }}
        composerRef={composerRef}
      />,
    ),
  );
const button = (text: string) => {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};
const click = (text: string) => act(async () => button(text).click());
async function fill(text: string) {
  const textarea = composerRef.current!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      text,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("shows the brief and newest ten entries first, with older entries and the full audit reachable", async () => {
  boundary.events = Array.from({ length: 129 }, (_, i) => event(i));
  boundary.events.push({ ...event(130), type: "auto", kind: "thread_settled", ref: "thread" });
  await render();
  expect(container.querySelector('[aria-label="Brief"]')?.textContent).toContain(
    "Done when: history is readable.",
  );
  const history = container.querySelector('[aria-label="Ticket timeline"]')!;
  expect(history.querySelectorAll("article")).toHaveLength(10);
  expect(history.querySelector("article")?.textContent).toContain("Evidence 128");
  expect(history.textContent).not.toContain("Thread settled");
  expect(
    container.querySelector("#ticket-entry-composer")!.compareDocumentPosition(history) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await click("Show older (119 remaining)");
  expect(history.querySelectorAll("article")).toHaveLength(30);
  await click("All");
  expect(history.querySelector("article")?.textContent).toContain("Thread settled");
  while (
    [...history.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Show older"))
  ) {
    await act(async () =>
      [...history.querySelectorAll("button")]
        .find((b) => b.textContent?.startsWith("Show older"))!
        .click(),
    );
  }
  expect(history.querySelectorAll("article")).toHaveLength(130);
  expect(history.textContent).toContain("Evidence 0");
});

it.each(["answer", "dismiss"] as const)(
  "requires and retains a %s, retries the same request, and reloads the recorded resolution",
  async (mode) => {
    boundary.events = [event(1, "question")];
    await render();
    await click("Answer or dismiss");
    expect(document.activeElement).toBe(composerRef.current);
    if (mode === "dismiss")
      await act(async () => {
        const select = container.querySelector<HTMLSelectElement>('[aria-label="Resolution"]')!;
        select.value = "dismiss";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    expect(button("Record resolution").disabled).toBe(true);
    await fill("Use the existing Home.");
    boundary.fail = true;
    await click("Record resolution");
    expect(composerRef.current?.value).toBe("Use the existing Home.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your text is kept");
    boundary.fail = false;
    await click("Record resolution");
    const first = boundary.add.mock.calls[0]![0].input as TicketEntryInput;
    const retry = boundary.add.mock.calls[1]![0].input as TicketEntryInput;
    expect(retry).toEqual(first);
    expect(retry.resolves).toBe("entry-001");
    expect(retry.text).toBe(
      `${mode === "answer" ? "Answer" : "Dismissed"}: Use the existing Home.`,
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(
      container.querySelector('[aria-label="Open questions and blockers"]')?.textContent,
    ).not.toContain("Evidence 1");
    const history = container.querySelector('[aria-label="Ticket timeline"]')!;
    expect(history.textContent).toContain(retry.text);
    expect(history.textContent).toContain("Resolves: Evidence 1");
    expect(history.textContent).toContain("Resolved");
  },
);

it("keeps write controls unavailable without Ticket permission", async () => {
  boundary.events = [event(1, "question")];
  boundary.allowed = false;
  await render();
  expect(button("Answer or dismiss").disabled).toBe(true);
  expect(composerRef.current?.disabled).toBe(true);
  expect(button("Add entry").disabled).toBe(true);
  await click("Answer or dismiss");
  expect(boundary.add).not.toHaveBeenCalled();
});

it("protects an unfinished draft when a question or decision is selected", async () => {
  boundary.events = [event(1, "question"), event(2, "decision")];
  await render();
  await fill("My unfinished update");
  expect(button("Answer or dismiss").disabled).toBe(true);
  expect(button("Supersede").disabled).toBe(true);
  await click("Answer or dismiss");
  expect(composerRef.current?.value).toBe("My unfinished update");
  await fill("");
  expect(button("Answer or dismiss").disabled).toBe(false);
});
it("resolves a blocker from another Run using a recorded explanation", async () => {
  boundary.events = [{ ...event(1, "blocker"), by: { actor: "agent", machine: "A" } }];
  await render();
  await click("Resolve blocker");
  expect(button("Record resolution").disabled).toBe(true);
  await fill("The volume is available again.");
  await click("Record resolution");
  await render();
  expect(boundary.add.mock.calls[0]![0].input).toMatchObject({
    resolves: "entry-001",
    text: "Resolved: The volume is available again.",
  });
  expect(container.querySelector('[aria-label="Open questions and blockers"]')?.textContent).toBe(
    "",
  );
});
it("shows the next action's own source after an answer adds newer evidence", async () => {
  boundary.events = [
    { ...event(1, "handoff"), next: "Implement option A" },
    { ...event(2, "note"), text: "Answer: option A" },
  ];
  await render();
  const current = container.querySelector('[aria-label="Current evidence"]')!;
  expect(current.textContent).toContain("Answer: option A");
  expect(current.textContent).toContain("Implement option A");
  expect(current.textContent).toContain(
    `Next recorded by Nick on MacBook · ${new Date(boundary.events[0]!.at).toLocaleString()}`,
  );
});
it("short multiline evidence can be expanded without losing its final lines", async () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
  boundary.events = [{ ...event(1, "handoff"), text: "one\ntwo\nthree\nfour\nfive\nsix" }];
  await render();
  await click("Read full entry");
  expect(button("Show less").getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector('[aria-label="Current evidence"]')?.textContent).toContain("six");
});
it("does not offer expansion when the current evidence fits", async () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  boundary.events = [{ ...event(1, "handoff"), text: "one\ntwo" }];
  await render();
  expect(container.querySelector('[aria-label="Current evidence"]')?.textContent).not.toContain(
    "Read full entry",
  );
});

it("exposes the current Brief source, corrections and original field values in read-only history", async () => {
  const first = {
    ticketId: ticket.id,
    eventId: "001",
    at: ticket.createdAt,
    by: { actor: "user" as const, machine: "A" },
  };
  boundary.allowed = false;
  boundary.events = [
    {
      ...first,
      type: "created",
      title: "Original premise",
      body: "Original broad scope",
      projectKey: null,
      source: "web",
      originThread: null,
    },
    {
      ...first,
      eventId: "002",
      type: "fields",
      title: ticket.title,
      body: ticket.body,
      by: { actor: "agent", machine: "A", model: "codex" },
    },
    { ...event(3, "decision"), text: "Nick accepted validation only; no implementation approval." },
    { ...event(4, "decision"), text: "Corrected premise, source retained." },
  ];
  await render();
  const brief = container.querySelector('[aria-label="Brief"]')!;
  expect(brief.textContent).toContain(ticket.body);
  expect(brief.textContent).toContain("Brief recorded by");
  const link = brief.querySelector<HTMLAnchorElement>('a[href="#ticket-decisions"]')!;
  expect(link.textContent).toContain("2 current decisions and corrections");
  const decisions = container.querySelector('[aria-label="Decisions"]')!;
  expect(decisions.querySelector("article")?.textContent).toContain("Corrected premise");
  expect(button("Add entry").disabled).toBe(true);
  await click("All");
  const timeline = container.querySelector('[aria-label="Ticket timeline"]')!;
  expect(timeline.textContent).toContain("Recorded title: Original premise");
  expect(timeline.textContent).toContain("Recorded brief:");
  expect(timeline.textContent).toContain("Original broad scope");
  expect(boundary.add).not.toHaveBeenCalled();
});
