import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as AreaProjects from "../../../project/AreaProjects.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Fork: Nick's Area projects (~/Projects/<area>/<folder>), backed by the `projects` command.
const Result = Schema.Record(Schema.String, Schema.Json);
const AreaProjectRef = TrimmedNonEmptyString.annotate({
  description: "<area>/<folder>, e.g. creative/macbook-game, or a unique project id.",
});
const ProjectStatus = Schema.Literals(["active", "paused", "done", "archived"]);
const TaskStatus = Schema.Literals(["todo", "doing", "done", "dropped"]);

const shared = {
  success: Result,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    ServerSettings.ServerSettingsService,
    SecureRandom.SecureRandom,
    AreaProjects.AreaProjects,
  ],
};

const AreasListTool = Tool.make("t3_areas_list", {
  ...shared,
  description:
    "List Nick's Areas (systems, work, creative…), the groups Area projects live in. Only Nick creates Areas.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AreaProjectsListTool = Tool.make("t3_area_projects_list", {
  ...shared,
  description:
    "List Nick's Area projects with purpose, goal, status, open task count and `t3ProjectId` when added to T3. Archived ones only with status archived or all.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    area: Schema.optional(TrimmedNonEmptyString),
    status: Schema.optional(Schema.Literals(["active", "paused", "done", "archived", "all"])),
    query: Schema.optional(TrimmedNonEmptyString),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AreaProjectReadTool = Tool.make("t3_area_project_read", {
  ...shared,
  description: "Read one Area project: metadata, README, STATUS.md notes and tasks with their ids.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    project: AreaProjectRef,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AreaProjectCreateTool = Tool.make("t3_area_project_create", {
  ...shared,
  description:
    "Create an Area project: folder in ~/Projects/<area>/ with README, AGENTS, STATUS, TASKS and git, added to T3. Without `apply: true` it only previews.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    area: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString,
    purpose: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "One or two sentences." }),
    ),
    goal: Schema.optional(TrimmedNonEmptyString),
    slug: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Folder name; from `name` if omitted." }),
    ),
    apply: Schema.optional(Schema.Boolean),
  }),
}).annotate(Tool.Destructive, true);

const AreaProjectUpdateTool = Tool.make("t3_area_project_update", {
  ...shared,
  description:
    "Change an Area project's title, purpose, goal (empty clears) or status. `archived` hides it here and in T3, keeping files; `active` restores.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    project: AreaProjectRef,
    title: Schema.optional(TrimmedNonEmptyString),
    purpose: Schema.optional(Schema.String),
    goal: Schema.optional(Schema.String),
    status: Schema.optional(ProjectStatus),
  }),
}).annotate(Tool.Destructive, true);

const AreaProjectTaskTool = Tool.make("t3_area_project_task", {
  ...shared,
  description:
    "Add a task to an Area project (omit `id`, give `title`) or change one (`id` such as t3, with status, title or note). Tasks are never deleted; use status dropped.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    project: AreaProjectRef,
    id: Schema.optional(TrimmedNonEmptyString),
    title: Schema.optional(TrimmedNonEmptyString),
    note: Schema.optional(Schema.String),
    status: Schema.optional(TaskStatus),
  }),
}).annotate(Tool.Destructive, false);

export const AreaProjectsToolkit = Toolkit.make(
  AreasListTool,
  AreaProjectsListTool,
  AreaProjectReadTool,
  AreaProjectCreateTool,
  AreaProjectUpdateTool,
  AreaProjectTaskTool,
);
