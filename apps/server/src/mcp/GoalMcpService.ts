import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2ServerCommand,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { dispatchFailure, unavailable } from "./threadAccess.ts";

type Report = Extract<OrchestrationV2ServerCommand, { type: "thread.goal.report" }>["report"];
type Proposal = Omit<
  Extract<OrchestrationV2ServerCommand, { type: "thread.goal.propose" }>,
  "type" | "commandId" | "threadId"
>;

export class GoalMcpService extends Context.Service<
  GoalMcpService,
  {
    readonly report: (
      threadId: ThreadId,
      report: Report,
    ) => Effect.Effect<{ iteration: number; recorded: boolean }, OrchestratorMcpFailure>;
    readonly propose: (
      threadId: ThreadId,
      proposal: Proposal,
    ) => Effect.Effect<{ proposed: boolean }, OrchestratorMcpFailure>;
  }
>()("t3/mcp/GoalMcpService") {}

const notAnIteration = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "This thread is not running the current /t3-goal iteration.",
  });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const report = Effect.fn("GoalMcpService.report")(function* (threadId: ThreadId, value: Report) {
    const caller = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    const marker = caller?.goalIteration;
    if (caller == null || caller.deletedAt !== null || marker == null)
      return yield* notAnIteration();
    const parent = yield* threads
      .getThreadShell(marker.parentThreadId)
      .pipe(Effect.mapError(unavailable));
    const goal = parent?.t3Goal;
    if (
      parent?.deletedAt !== null ||
      goal == null ||
      goal.id !== marker.goalId ||
      goal.iteration !== marker.iteration ||
      goal.currentChildThreadId !== caller.id
    )
      return yield* notAnIteration();
    const text = value.type === "note" ? value.text.trim() : value.summary.trim();
    if (text === "")
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A goal report needs a non-empty note or summary.",
      });
    const normalized: Report =
      value.type === "note" ? { ...value, text } : { ...value, summary: text };
    yield* threads
      .dispatch({
        type: "thread.goal.report",
        commandId: CommandId.make(
          `goal-report:${caller.id}:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
        ),
        threadId: marker.parentThreadId,
        goalId: marker.goalId,
        iteration: marker.iteration,
        childThreadId: caller.id,
        report: normalized,
      })
      .pipe(Effect.mapError(dispatchFailure));
    return { iteration: marker.iteration, recorded: true };
  });
  const propose = Effect.fn("GoalMcpService.propose")(function* (
    threadId: ThreadId,
    input: Proposal,
  ) {
    const objective = input.objective.trim();
    const doneWhen = input.doneWhen.trim();
    if (objective === "" || doneWhen === "")
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A goal proposal needs an objective and a doneWhen.",
      });
    yield* threads
      .dispatch({
        ...input,
        type: "thread.goal.propose",
        commandId: CommandId.make(
          `goal-propose:${threadId}:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
        ),
        threadId,
        objective,
        doneWhen,
      })
      .pipe(Effect.mapError(dispatchFailure));
    return { proposed: true };
  });
  return GoalMcpService.of({ report, propose });
});

export const layer = Layer.effect(GoalMcpService, make);
