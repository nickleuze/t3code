import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Deployments from "../../../deploy/HostDeployment.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DeploymentToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(DeploymentToolkit, {
  t3_deployment_status: McpToolAccess.reads(() =>
    Deployments.HostDeployment.pipe(
      Effect.flatMap((deployments) => deployments.list),
      Effect.map((deployments) => ({ deployments })),
    ),
  ),
  t3_deployment_record_acceptance: McpToolAccess.writes((input) =>
    Deployments.HostDeployment.pipe(
      Effect.flatMap((deployments) => deployments.recordAcceptance(input)),
      Effect.mapError(
        (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    ),
  ),
});
