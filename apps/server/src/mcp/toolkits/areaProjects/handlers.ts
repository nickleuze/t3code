import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as AreaProjects from "../../../project/AreaProjects.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AreaProjectsToolkit } from "./tools.ts";

const run = (tool: AreaProjects.AreaProjectTool, args: object) =>
  AreaProjects.AreaProjects.pipe(
    Effect.flatMap((service) => service.run(tool, args as Readonly<Record<string, unknown>>)),
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
    ),
  );

export const layer = McpToolAccess.toLayer(AreaProjectsToolkit, {
  t3_areas_list: McpToolAccess.reads(() => run("projects_areas", {})),
  t3_area_projects_list: McpToolAccess.reads((input) => run("projects_list", input)),
  t3_area_project_read: McpToolAccess.reads((input) => run("projects_get", input)),
  t3_area_project_create: McpToolAccess.writesEnvironment((input) => run("projects_create", input)),
  t3_area_project_update: McpToolAccess.writesEnvironment((input) => run("projects_update", input)),
  t3_area_project_task: McpToolAccess.writes(
    ({ id, status, ...input }) =>
      id !== undefined
        ? run("projects_task_update", { ...input, id, ...(status ? { status } : {}) })
        : run("projects_task_add", input).pipe(
            Effect.flatMap((added) => {
              const task = added.task as { readonly id?: string } | undefined;
              return status === undefined || status === "todo" || task?.id === undefined
                ? Effect.succeed(added)
                : run("projects_task_update", { project: input.project, id: task.id, status });
            }),
          ),
    { linkedCallers: "allowed" },
  ),
});
