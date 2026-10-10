import { OrchestratorMcpFailure } from "@t3tools/contracts";
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
    "Record a short progress note for the /t3-goal iteration this thread is running: one or two sentences on what changed. Detailed state belongs in the goal's handoff file; pass handoffPath (relative to the workspace) when you create or move it. Only works inside a goal iteration thread.",
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
    'End the /t3-goal loop from inside a goal iteration. Use status "complete" when the whole goal is achieved; if the goal has a check command, T3 Code runs it after your turn and keeps iterating if it fails. Use status "blocked" only when work cannot continue for a long time, and say what you need; for a quick decision, ask the user with your question tool instead. Your turn should end soon after calling this.',
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
  description: [
    "Propose a /t3-goal for this thread: a long-running loop in which T3 Code runs fresh agent iterations, each starting from the goal, its progress notes and a handoff file, until the goal is done. Nothing runs until the user clicks Start on the proposal card, so propose freely when it fits.",
    "Call it when the user asks to make something a goal or to keep working on it over a long stretch, and on your own when the task clearly needs more than one session: many dependent steps, long build or CI cycles, broad migrations or refactors, or iterating until a test suite passes. Do not propose for work you can finish in this turn.",
    "Infer every field from the conversation and the workspace instead of asking the user. Write background for a fresh agent that has not seen this conversation: decisions, constraints, relevant files and the plan. Only list preApprovedActions the user already approved here, such as committing or pushing to a branch; never invent permissions. Only set checkCommand when you know a command that exits 0 exactly when the goal is met.",
    "After proposing, tell the user in one short sentence that the goal is ready to start, and end your turn without starting the work yourself.",
  ].join(" "),
  parameters: Schema.Struct({
    objective: text(500),
    doneWhen: text(1_000),
    background: Schema.optional(text(6_000)),
    checkCommand: Schema.optional(text(500)),
    preApprovedActions: Schema.optional(text(1_000)),
    minutesPerIteration: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 15, maximum: 480 })),
    ),
    reason: Schema.optional(text(300)),
  }),
  success: Schema.Struct({ proposed: Schema.Boolean }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const GoalToolkit = Toolkit.make(GoalUpdateTool, GoalCompleteTool, GoalProposeTool);
