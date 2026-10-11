import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TicketId,
} from "@t3tools/contracts";
import { launchLinkedTicketThread } from "./ticketLaunch";

const environmentId = EnvironmentId.make("isolated");
const ticketId = TicketId.make("ticket");
const input = {
  commandId: CommandId.make("stable-command"),
  threadId: ThreadId.make("stable-thread"),
  projectId: ProjectId.make("project"),
  title: "Ticket",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
  runtimeMode: "auto" as const,
  interactionMode: "default" as const,
  workspaceStrategy: { type: "root" as const },
  initialMessage: { text: "Work", attachments: [] },
};
function commands() {
  return {
    link: vi.fn().mockResolvedValue(AsyncResult.success({})),
    launch: vi.fn().mockResolvedValue(AsyncResult.success({ threadId: input.threadId })),
    unlink: vi.fn().mockResolvedValue(AsyncResult.success({})),
  };
}
describe("ticket launch", () => {
  it("persists the work link before launch, and a link failure starts nothing", async () => {
    const rpc = commands();
    rpc.link.mockResolvedValueOnce(AsyncResult.failure(Cause.die(new Error("offline"))));
    const failed = await launchLinkedTicketThread({ environmentId, ticketId, input, ...rpc });
    expect(failed.step).toBe("link");
    expect(rpc.launch).not.toHaveBeenCalled();
    await launchLinkedTicketThread({ environmentId, ticketId, input, ...rpc });
    expect(rpc.link.mock.invocationCallOrder[1]).toBeLessThan(
      rpc.launch.mock.invocationCallOrder[0]!,
    );
    expect(rpc.link.mock.calls[1]?.[0]).toEqual({
      environmentId,
      input: { id: ticketId, threadId: input.threadId, role: "work" },
    });
  });
  it("an ambiguous failure keeps the link and retries the identical command and thread", async () => {
    const rpc = commands();
    rpc.launch.mockResolvedValueOnce(AsyncResult.failure(Cause.die(new Error("response lost"))));
    await launchLinkedTicketThread({ environmentId, ticketId, input, ...rpc });
    expect(rpc.unlink).not.toHaveBeenCalled();
    await launchLinkedTicketThread({ environmentId, ticketId, input, ...rpc });
    expect(rpc.launch.mock.calls.map(([value]) => value.input)).toEqual([input, input]);
  });
  it("removes the prelink for a definite authorization rejection", async () => {
    const rpc = commands();
    rpc.launch.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail({ _tag: "EnvironmentAuthorizationError" })),
    );
    await launchLinkedTicketThread({ environmentId, ticketId, input, ...rpc });
    expect(rpc.unlink).toHaveBeenCalledWith({
      environmentId,
      input: { id: ticketId, threadId: input.threadId },
    });
  });
  it("keeps the link for server failures that may follow committed creation", async () => {
    const rpc = commands();
    rpc.launch.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail({
          _tag: "OrchestrationV2ThreadLaunchError",
          cause: { _tag: "ThreadLaunchError", operation: "create-thread" },
        }),
      ),
    );
    await launchLinkedTicketThread({ environmentId, ticketId, input, ...rpc });
    expect(rpc.unlink).not.toHaveBeenCalled();
  });
  it("a later rejection cannot erase a link after an earlier ambiguous launch", async () => {
    const rpc = commands();
    rpc.launch.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail({ _tag: "EnvironmentAuthorizationError" })),
    );
    await launchLinkedTicketThread({
      environmentId,
      ticketId,
      input,
      ...rpc,
      unlinkOnRejection: false,
    });
    expect(rpc.unlink).not.toHaveBeenCalled();
  });
});
