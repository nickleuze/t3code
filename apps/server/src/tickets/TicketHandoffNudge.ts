import {
  CommandId,
  MessageId,
  type OrchestrationV2TurnItem,
  type TicketEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as Settings from "../serverSettings.ts";
import * as Tickets from "./TicketService.ts";

const PREFIX = "Automatic ticket handoff request from T3 Code:";
const TOOL_TYPES = new Set([
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "mcp_tool_call",
  "image_generation",
  "browser_action",
  "todo_list",
  "user_input_request",
]);
export function ticketPolicyReadOnly(sandbox: unknown): boolean {
  return (
    sandbox === "read-only" ||
    (sandbox !== null &&
      typeof sandbox === "object" &&
      "type" in sandbox &&
      (sandbox.type === "read-only" || sandbox.type === "readOnly"))
  );
}
export function needsTicketHandoff(input: {
  enabled: boolean;
  interactionMode?: string;
  readOnly?: boolean;
  stage?: string;
  thread: ThreadId;
  machine: string;
  startedAt: string;
  completedAt: string;
  items: readonly (Pick<OrchestrationV2TurnItem, "type"> &
    Partial<Pick<OrchestrationV2TurnItem, "id">>)[];
  events: readonly TicketEvent[];
  isNudgeTurn: boolean;
}): boolean {
  return (
    input.enabled &&
    input.interactionMode !== "plan" &&
    !input.readOnly &&
    input.stage !== "done" &&
    input.stage !== "dropped" &&
    !input.isNudgeTurn &&
    input.items.some(
      (item) =>
        TOOL_TYPES.has(item.type) &&
        !String(item.id ?? "").includes("native-item:workspace-preparation"),
    ) &&
    !input.events.some(
      (event) =>
        event.type === "entry" &&
        event.by.thread === input.thread &&
        event.by.machine === input.machine &&
        event.at >= input.startedAt &&
        event.at <= input.completedAt,
    )
  );
}

export const make = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const tickets = yield* Tickets.TicketService;
  const settings = yield* Settings.ServerSettingsService;
  const runtimePolicy = yield* Effect.serviceOption(RuntimePolicy.RuntimePolicyV2);
  const nudged = new Set<string>();
  const worker = yield* makeDrainableWorker(
    (run: { id: import("@t3tools/contracts").RunId; threadId: ThreadId }) =>
      Effect.gen(function* () {
        if (nudged.has(run.id)) return;
        if (!(yield* settings.getSettings).ticketHandoffNudge) return;
        const { thread, runs, turnItems, messages } = yield* orchestrator.getThreadRecords(
          run.threadId,
          ["runs", "turnItems", "messages"],
          { turnItemRunId: run.id, runIds: [run.id], messageRunIds: [run.id] },
        );
        if (
          thread.deletedAt !== null ||
          thread.archivedAt !== null ||
          thread.interactionMode === "plan"
        )
          return;
        if (runtimePolicy._tag === "Some") {
          const policy = yield* runtimePolicy.value.resolve({
            thread,
            modelSelection: thread.modelSelection,
          });
          if (ticketPolicyReadOnly(policy.sandboxPolicy)) return;
        }
        const finished = runs.find((r) => r.id === run.id);
        if (!finished?.startedAt || !finished.completedAt) return;
        const machine = tickets.author().machine;
        const linked = (yield* tickets.list()).tickets.filter((ticket) =>
          ticket.links.some(
            (link) =>
              link.threadId === thread.id &&
              link.machine === machine &&
              ["work", "planning", "review"].includes(link.role),
          ),
        );
        const eligible = [];
        for (const ticket of linked) {
          const { events } = yield* tickets.timeline({ id: ticket.id });
          if (
            needsTicketHandoff({
              enabled: true,
              interactionMode: thread.interactionMode,
              stage: ticket.status,
              thread: thread.id,
              machine,
              startedAt: DateTime.formatIso(finished.startedAt),
              completedAt: DateTime.formatIso(finished.completedAt),
              items: turnItems.filter((item) => item.runId === run.id),
              events,
              isNudgeTurn: messages.some(
                (message) => message.role === "user" && message.text.startsWith(PREFIX),
              ),
            })
          )
            eligible.push(ticket.id);
        }
        if (!eligible.length) return;
        const id = `ticket-handoff:${thread.id}:${run.id}`;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          messageId: MessageId.make(id),
          threadId: thread.id,
          text: `${PREFIX} This turn used tools without recording a ticket entry. Write a handoff with t3_ticket_entry for ${eligible.join(", ")}: what changed, decisions, and Next:. This is a record-keeping request, not new work or approval.`,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
        nudged.add(run.id);
        if (nudged.size > 2048) nudged.delete(nudged.values().next().value!);
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("tickets.handoff-nudge.failed", { cause })),
      ),
  );
  const start = Effect.gen(function* () {
    const afterSequence = yield* sink.latestSequence().pipe(Effect.orDie);
    yield* sink.stream({ afterSequence, eventType: "run.updated" }).pipe(
      Stream.runForEach((stored) =>
        stored.event.type === "run.updated" &&
        stored.event.payload.status === "completed" &&
        !String(stored.commandId).startsWith("command:runtime-reconcile:")
          ? worker.enqueue(stored.event.payload)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
  });
  return { start, observe: worker.enqueue, drain: worker.drain };
});
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* make;
    yield* worker.start;
  }),
);
