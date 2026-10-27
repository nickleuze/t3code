import {
  HostDeployment,
  HostDeploymentAcceptanceInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Deployments from "../../../deploy/HostDeployment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Deployments.HostDeployment,
  ],
};

const DeploymentStatusTool = Tool.make("t3_deployment_status", {
  ...shared,
  description:
    "Read this host's release deployments: status, step, why one waits, is blocked or failed, and its milestones. Only the user approves, admits or overrides them, in the app.",
  success: Schema.Struct({ deployments: Schema.Array(HostDeployment) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const DeploymentAcceptanceTool = Tool.make("t3_deployment_record_acceptance", {
  ...shared,
  description:
    "Record acceptance of a verified release on this host after checking its approved scope on the installed app. `scope` must equal its acceptanceScope; put what you checked and saw in `summary` and `evidence`.",
  parameters: HostDeploymentAcceptanceInput,
  success: HostDeployment,
}).annotate(Tool.Destructive, false);

export const DeploymentToolkit = Toolkit.make(DeploymentStatusTool, DeploymentAcceptanceTool);
