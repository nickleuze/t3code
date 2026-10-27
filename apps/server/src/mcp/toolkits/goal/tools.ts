import { MIN_GOAL_ITERATION_TIMEOUT_MINS, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as GoalMcpService from "../../GoalMcpService.ts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    GoalMcpService.GoalMcpService,
  ],
};

const Recorded = Schema.Struct({ iteration: Schema.Number, recorded: Schema.Boolean });

const GoalUpdateTool = Tool.make("t3_goal_update", {
  ...shared,
  description:
    "Record a one- or two-sentence progress note for this /t3-goal iteration. Details go in the handoff file; pass `handoffPath` (workspace-relative) when you create or move it. Goal iteration threads only.",
  parameters: Schema.Struct({
    note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
    handoffPath: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    ),
  }),
  success: Recorded,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const GoalCompleteTool = Tool.make("t3_goal_complete", {
  ...shared,
  description:
    'End this /t3-goal loop from its iteration. "complete": the whole goal is achieved. "blocked": work cannot continue for a long time; say what you need. For a quick decision, ask the user instead. End your turn soon after.',
  parameters: Schema.Struct({
    status: Schema.Literals(["complete", "blocked"]),
    summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  }),
  success: Recorded,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

const GoalProposeTool = Tool.make("t3_goal_propose", {
  ...shared,
  description:
    "Propose a /t3-goal: T3 Code runs fresh iterations from the goal, its notes and a handoff file until it is done. Nothing runs until the user clicks Start. Use it when asked for a goal or long-running work, or on your own when the task clearly needs more than one session (many dependent steps, long CI cycles, broad migrations, iterating until tests pass), never for work you can finish this turn. Infer every field; do not ask. Write `background` for a fresh agent: decisions, constraints, files, plan. List only `preApprovedActions` the user approved here. Then say in one sentence it is ready to start, and end your turn.",
  parameters: Schema.Struct({
    objective: text(500),
    doneWhen: text(1_000),
    background: Schema.optional(text(6_000)),
    preApprovedActions: Schema.optional(text(1_000)),
    minutesPerIteration: Schema.optional(
      Schema.Int.check(
        Schema.isBetween({ minimum: MIN_GOAL_ITERATION_TIMEOUT_MINS, maximum: 480 }),
      ),
    ),
    reason: Schema.optional(text(300)),
  }),
  success: Schema.Struct({ proposed: Schema.Boolean }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const GoalToolkit = Toolkit.make(GoalUpdateTool, GoalCompleteTool, GoalProposeTool);
