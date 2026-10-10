import * as Effect from "effect/Effect";
import * as GoalMcpService from "../../GoalMcpService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { readCaller } from "../../threadAccess.ts";
import { GoalToolkit } from "./tools.ts";

const callerId = Effect.gen(function* () {
  const { scope } = yield* readCaller();
  return (yield* McpInvocationContext.requireThreadScope(scope, "Goal tools")).thread.threadId;
});
const trimmedOrNull = (value: string | undefined) => value?.trim() || null;

export const layer = McpToolAccess.toLayer(GoalToolkit, {
  t3_goal_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalMcpService.GoalMcpService;
      return yield* goals.report(yield* callerId, {
        type: "note",
        text: input.note,
        ...(trimmedOrNull(input.handoffPath) === null
          ? {}
          : { handoffPath: input.handoffPath!.trim() }),
      });
    }),
  ),
  t3_goal_complete: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalMcpService.GoalMcpService;
      return yield* goals.report(yield* callerId, {
        type: "claim",
        status: input.status,
        summary: input.summary,
      });
    }),
  ),
  t3_goal_propose: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalMcpService.GoalMcpService;
      return yield* goals.propose(yield* callerId, {
        objective: input.objective,
        doneWhen: input.doneWhen,
        background: trimmedOrNull(input.background),
        checkCommand: trimmedOrNull(input.checkCommand),
        permissions: trimmedOrNull(input.preApprovedActions),
        iterationTimeoutMins: input.minutesPerIteration ?? null,
        reason: trimmedOrNull(input.reason),
      });
    }),
  ),
});
