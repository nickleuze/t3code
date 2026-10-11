import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, TicketId } from "@t3tools/contracts";

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
const environmentId = EnvironmentId.make("ticket-host");
const ticketId = TicketId.make("ticket");
const threadId = ThreadId.make("original-bootstrap");
const pending = { environmentId, ticketId, threadId };

beforeEach(() => {
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
