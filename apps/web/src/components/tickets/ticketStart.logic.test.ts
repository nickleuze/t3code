import {
  EnvironmentId,
  ProjectId,
  TicketId,
  TicketNotFound,
  TicketLaunchNeedsProject,
  type TicketStartResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import {
  ticketLaunchRequest,
  startTicketWithRefresh,
  ticketLaunchFailureTag,
} from "./ticketStart.logic";

const environment = EnvironmentId.make("mac-a");
const other = EnvironmentId.make("mac-b");
const ticketId = TicketId.make("ticket");
const request = () => ticketLaunchRequest(null, environment, ticketId, "plan");
const missing = AsyncResult.failure<TicketStartResult, TicketNotFound>(
  Cause.fail(new TicketNotFound({ ticketId })),
);
const needsProject = AsyncResult.failure<TicketStartResult, TicketLaunchNeedsProject>(
  Cause.fail(new TicketLaunchNeedsProject({ ticketId })),
);

it("repeats reuse receipt IDs only for the same ticket, mode and destination", () => {
  const pending = request();
  expect(ticketLaunchRequest(pending, environment, ticketId, "plan")).toBe(pending);
  for (const next of [
    ticketLaunchRequest(pending, environment, ticketId, "goal"),
    ticketLaunchRequest(pending, other, ticketId, "plan"),
    ticketLaunchRequest(pending, environment, TicketId.make("another"), "plan"),
  ]) {
    expect(next.input.threadId).not.toBe(pending.input.threadId);
    expect(next.input.commandId).not.toBe(pending.input.commandId);
  }
});

it("keeps the picked project on a repeat, but a different project starts fresh", () => {
  const project = ProjectId.make("one");
  const pending = ticketLaunchRequest(null, environment, ticketId, "plan", project);
  expect(ticketLaunchRequest(pending, environment, ticketId, "plan")).toBe(pending);
  expect(
    ticketLaunchRequest(pending, environment, ticketId, "plan", ProjectId.make("two")).input
      .threadId,
  ).not.toBe(pending.input.threadId);
});

it("refreshes the target once and retries the exact request, including needs-project afterward", async () => {
  const input = request();
  const start = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(needsProject);
  const refresh = vi.fn(async () => undefined);
  const result = await startTicketWithRefresh(input, start, refresh);
  expect(refresh).toHaveBeenCalledOnce();
  expect(start.mock.calls).toEqual([[input], [input]]);
  expect(ticketLaunchFailureTag(result)).toBe("TicketLaunchNeedsProject");
});

it("stops after the second missing result; other failures never refresh", async () => {
  const start = vi.fn(async () => missing);
  const refresh = vi.fn(async () => undefined);
  expect(await startTicketWithRefresh(request(), start, refresh)).toBe(missing);
  expect(start).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledOnce();
  refresh.mockClear();
  expect(await startTicketWithRefresh(request(), async () => needsProject, refresh)).toBe(
    needsProject,
  );
  expect(refresh).not.toHaveBeenCalled();
});
