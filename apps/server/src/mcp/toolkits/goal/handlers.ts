import { CommandId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { readMutationCaller, unavailable } from "../../threadAccess.ts";
import { GoalToolkit } from "./tools.ts";

const notAnIteration = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "This thread is not running the current /goal iteration.",
  });

/** Report into the parent's goal, only from the child running its current iteration. */
const report = (
  value:
    | { readonly type: "note"; readonly text: string }
    | { readonly type: "claim"; readonly status: "complete" | "blocked"; readonly summary: string },
) =>
  Effect.gen(function* () {
    const { threads, caller } = yield* readMutationCaller();
    const marker = caller.goalIteration;
    if (marker == null) return yield* notAnIteration();
    const parent = yield* threads
      .getThreadShell(marker.parentThreadId)
      .pipe(Effect.mapError(unavailable));
    const goal = parent?.goal;
    if (
      goal == null ||
      goal.id !== marker.goalId ||
      goal.iteration !== marker.iteration ||
      goal.currentChildThreadId !== caller.id
    ) {
      return yield* notAnIteration();
    }
    const crypto = yield* Crypto.Crypto;
    const commandId = CommandId.make(
      `goal-report:${caller.id}:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
    );
    yield* threads
      .dispatch({
        type: "thread.goal.report",
        commandId,
        threadId: marker.parentThreadId,
        goalId: marker.goalId,
        iteration: marker.iteration,
        childThreadId: caller.id,
        report: value,
      })
      .pipe(Effect.mapError(notAnIteration));
    return { iteration: marker.iteration, recorded: true };
  });

export const GoalHandlersLive = GoalToolkit.toLayer({
  t3_goal_update: ({ note }) => report({ type: "note", text: note.trim() }),
  t3_goal_complete: ({ status, summary }) =>
    report({ type: "claim", status, summary: summary.trim() }),
});
