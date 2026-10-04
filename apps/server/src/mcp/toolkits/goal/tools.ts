import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};

const Recorded = Schema.Struct({ iteration: Schema.Number, recorded: Schema.Boolean });

const GoalUpdateTool = Tool.make("t3_goal_update", {
  ...shared,
  description:
    "Record a progress note for the /goal iteration this thread is running. The next iteration starts with a fresh context and sees only these notes, so say what you did, what you learned, and what should happen next. Only works inside a goal iteration thread.",
  parameters: Schema.Struct({
    note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  }),
  success: Recorded,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GoalCompleteTool = Tool.make("t3_goal_complete", {
  ...shared,
  description:
    'End the /goal loop from inside a goal iteration. Use status "complete" when the whole goal is achieved; if the goal has a check command, T3 Code runs it after your turn and keeps iterating if it fails. Use status "blocked" when progress needs the user, and say what you need. Your turn should end soon after calling this.',
  parameters: Schema.Struct({
    status: Schema.Literals(["complete", "blocked"]),
    summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  }),
  success: Recorded,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const GoalToolkit = Toolkit.make(GoalUpdateTool, GoalCompleteTool);
