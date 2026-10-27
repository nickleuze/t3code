import {
  InstalledSkillName,
  McpServerName,
  OrchestratorMcpFailure,
  ProjectId,
  SkillInstallInput,
  SkillInstallResult,
  SkillSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as SkillLibrary from "../../../skills/SkillLibrary.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    ProjectService.ProjectService,
    SkillLibrary.SkillLibrary,
  ],
};

/** Omit for the environment; a project id scopes the read or change to that project. */
const Scope = { projectId: Schema.optional(ProjectId) };

const ToolsState = Schema.Struct({
  disabledSkills: Schema.Array(Schema.String),
  mcpServers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      enabled: Schema.Boolean,
      /** The command line or URL; secret values are never returned. */
      summary: Schema.String,
    }),
  ),
});

const ToolsReadTool = Tool.make("t3_tools_read", {
  ...shared,
  description:
    "Read Settings → Tools for this environment or one `projectId`: skills switched off and the MCP servers T3 gives every agent session.",
  parameters: Schema.Struct(Scope),
  success: ToolsState,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ToolsUpdateTool = Tool.make("t3_tools_update", {
  ...shared,
  description:
    "Switch skills (named as agents invoke them) or Settings → Tools MCP servers on or off for this environment or one `projectId`. Needs a live full-access/default calling thread. Applies to new sessions.",
  parameters: Schema.Struct({
    ...Scope,
    skills: Schema.optional(
      Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, enabled: Schema.Boolean })),
    ),
    mcpServers: Schema.optional(
      Schema.Array(Schema.Struct({ name: McpServerName, enabled: Schema.Boolean })),
    ),
  }),
  success: ToolsState,
}).annotate(Tool.Destructive, true);

const SkillsInstallTool = Tool.make("t3_skills_install", {
  ...shared,
  description:
    "Install skills for every agent from a GitHub owner/repo, git URL or local folder, like `npx skills add`: into `projectId`'s .agents/skills, else ~/.agents/skills. Skills can run scripts; install only sources the user asked for. Needs a live full-access/default calling thread.",
  parameters: Schema.Struct({
    ...Scope,
    source: SkillSource,
    skills: SkillInstallInput.fields.skills,
  }),
  success: SkillInstallResult,
}).annotate(Tool.Destructive, true);

const SkillsRemoveTool = Tool.make("t3_skills_remove", {
  ...shared,
  description:
    "Remove an installed or hand-placed skill, and every agent's link to it, from this environment's or `projectId`'s skill folders. Plugin and built-in skills can only be switched off with `t3_tools_update`. Needs a live full-access/default calling thread.",
  parameters: Schema.Struct({ ...Scope, name: InstalledSkillName }),
  success: Schema.Struct({}),
}).annotate(Tool.Destructive, true);

export const ToolsToolkit = Toolkit.make(
  ToolsReadTool,
  ToolsUpdateTool,
  SkillsInstallTool,
  SkillsRemoveTool,
);
