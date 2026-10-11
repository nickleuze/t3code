import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, TicketId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  return { run: vi.fn(), toast: vi.fn() };
});
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.run }));
vi.mock("./rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./state/tickets", () => ({ ticketEnvironment: { linkTicket: {} } }));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import {
  linkFinalizedTicketDraft,
  linkPromotedTicketDraft,
  setPendingTicketDraft,
  usePendingTicketDrafts,
} from "./pendingTicketDrafts";
import { prunePendingTicketDrafts } from "./pendingTicketDraftStore";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
} from "./composerDraftStore";
const environmentId = EnvironmentId.make("ticket-host");
const ticketId = TicketId.make("ticket");
const threadId = ThreadId.make("original-bootstrap");
const pending = { environmentId, ticketId, threadId };

beforeEach(() => {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {},
    draftsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  usePendingTicketDrafts.setState({ links: {} });
  mocks.run.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.toast.mockClear();
});

describe("draft ticket linking", () => {
  it("recording or abandoning a draft makes no RPC; only its acknowledged promotion links it", async () => {
    setPendingTicketDraft("draft", pending);
    expect(mocks.run).not.toHaveBeenCalled();
    await linkPromotedTicketDraft("draft", { environmentId, threadId: ThreadId.make("unrelated") });
    expect(mocks.run).not.toHaveBeenCalled();
    await linkFinalizedTicketDraft("draft", { environmentId, threadId });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0]?.[2]).toEqual({
      environmentId,
      input: { id: ticketId, threadId, role: "work" },
    });
    expect(usePendingTicketDrafts.getState().links).toEqual({});
  });
  it("links the acknowledged replacement id after a failed bootstrap retry, within the ticket's environment", async () => {
    setPendingTicketDraft("draft", pending);
    const promoted = { environmentId, threadId: ThreadId.make("successful-retry") };
    await linkFinalizedTicketDraft("draft", {
      ...promoted,
      environmentId: EnvironmentId.make("other"),
    });
    expect(mocks.run).not.toHaveBeenCalled();
    await linkFinalizedTicketDraft("draft", promoted);
    expect(mocks.run.mock.calls[0]?.[2]).toEqual({
      environmentId,
      input: { id: ticketId, threadId: promoted.threadId, role: "work" },
    });
  });
  it("deduplicates simultaneous acknowledgements and retains failed links for retry", async () => {
    setPendingTicketDraft("draft", pending);
    let resolve!: (result: { _tag: string }) => void;
    mocks.run.mockReturnValueOnce(
      new Promise((result) => {
        resolve = result;
      }),
    );
    const first = linkFinalizedTicketDraft("draft", { environmentId, threadId });
    await linkFinalizedTicketDraft("draft", { environmentId, threadId });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    resolve({ _tag: "Failure" });
    await first;
    expect(usePendingTicketDrafts.getState().links.draft).toEqual(pending);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    await linkPromotedTicketDraft("draft", { environmentId, threadId });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(usePendingTicketDrafts.getState().links).toEqual({});
  });
});

function createDraft(id: string) {
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(
      { environmentId, projectId: ProjectId.make("project") },
      DraftId.make(id),
      { threadId },
    );
}
describe("pending draft lifecycle", () => {
  it("prunes absent identities on load and keeps existing drafts", async () => {
    createDraft("kept");
    localStorage.setItem(
      "t3-pending-ticket-drafts",
      JSON.stringify({ state: { links: { kept: pending, abandoned: pending } }, version: 0 }),
    );
    await usePendingTicketDrafts.persist.rehydrate();
    expect(usePendingTicketDrafts.getState().links).toEqual({ kept: pending });
    expect(JSON.parse(localStorage.getItem("t3-pending-ticket-drafts")!).state.links).toEqual({
      kept: pending,
    });
  });
  it("clears discarded drafts before an identity can be reused", () => {
    createDraft("discarded");
    setPendingTicketDraft("discarded", pending);
    useComposerDraftStore.getState().clearDraftThread(DraftId.make("discarded"));
    expect(usePendingTicketDrafts.getState().links).toEqual({});
    createDraft("discarded");
    expect(usePendingTicketDrafts.getState().links).toEqual({});
  });
  it("prunes only missing draft metadata, preserving a draft without composer content", () => {
    createDraft("empty");
    setPendingTicketDraft("empty", pending);
    setPendingTicketDraft("orphan", pending);
    prunePendingTicketDrafts(
      new Set(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)),
    );
    expect(usePendingTicketDrafts.getState().links).toEqual({ empty: pending });
  });
  it("promotion captures the link before pruning and retries from the captured target", async () => {
    createDraft("promoted");
    setPendingTicketDraft("promoted", pending);
    mocks.run.mockResolvedValueOnce({ _tag: "Failure" });
    finalizePromotedDraftThreadByRef({ environmentId, threadId });
    expect(usePendingTicketDrafts.getState().links).toEqual({});
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(mocks.run).toHaveBeenCalledTimes(1);
    mocks.toast.mock.calls[0]![0].actionProps.onClick();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    expect(mocks.run.mock.calls[1]?.[2]).toEqual({
      environmentId,
      input: { id: ticketId, threadId, role: "work" },
    });
    expect(usePendingTicketDrafts.getState().links).toEqual({});
  });
});
