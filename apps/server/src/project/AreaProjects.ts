import * as NodeOS from "node:os";
import {
  CommandId,
  ProjectId,
  type ProjectCreateNewInput,
  type ProjectCreateNewResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "./ProjectService.ts";

/** Fork: Nick's Area projects live in `~/Projects` and are managed by the `projects` command. */
export type AreaProjectTool =
  | "projects_areas"
  | "projects_list"
  | "projects_get"
  | "projects_create"
  | "projects_update"
  | "projects_tasks"
  | "projects_task_add"
  | "projects_task_update";

export class AreaProjectsError extends Schema.TaggedError<AreaProjectsError>()(
  "AreaProjectsError",
  { message: Schema.String },
) {}

type Json = { readonly [key: string]: Schema.Json };
type Args = Readonly<Record<string, unknown>>;

export class AreaProjects extends Context.Service<
  AreaProjects,
  {
    /** Runs one `projects` tool and keeps T3's project registrations in step with it. */
    readonly run: (tool: AreaProjectTool, args: Args) => Effect.Effect<Json, AreaProjectsError>;
    /** New project in the UI with an Area chosen. */
    readonly createNew: (
      input: ProjectCreateNewInput & { readonly area: string },
    ) => Effect.Effect<ProjectCreateNewResult, AreaProjectsError>;
  }
>()("t3/project/AreaProjects") {}

const decodeOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const encodeArgs = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.fn("AreaProjects.make")(function* (command: string) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const fail = (message: string) => new AreaProjectsError({ message });

  const call = Effect.fn("AreaProjects.call")(function* (tool: AreaProjectTool, args: Args) {
    if (!(yield* fs.exists(command).pipe(Effect.orElseSucceed(() => false))))
      return yield* fail(
        `The projects tool is not installed on this machine (${command}). Install it from github.com/nickleuze/projects.`,
      );
    const argsJson = yield* encodeArgs(args).pipe(
      Effect.mapError(() => fail("The arguments could not be sent to the projects tool.")),
    );
    const output = yield* runner
      .run({
        command,
        args: ["call", tool, argsJson],
        timeout: "30 seconds",
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(Effect.mapError(() => fail("The projects tool could not run.")));
    const result = yield* decodeOutput(output.stdout).pipe(
      Effect.mapError(() =>
        fail(`The projects tool failed: ${output.stderr.trim().slice(0, 300)}`),
      ),
    );
    if (typeof result.error === "string") return yield* fail(result.error);
    return result;
  });

  const registered = (path: unknown) =>
    typeof path === "string"
      ? projects.getByWorkspaceRoot(path).pipe(Effect.orElseSucceed(() => Option.none()))
      : Effect.succeedNone;

  const commandId = (kind: string) =>
    random.uuidV4().pipe(Effect.map((id) => ({ id, commandId: CommandId.make(`${kind}:${id}`) })));

  const withProjectId = (project: Json): Effect.Effect<Json> =>
    registered(project.path).pipe(
      Effect.map((found) => ({
        ...project,
        t3ProjectId: Option.isSome(found) ? found.value.id : null,
      })),
    );

  const run = Effect.fn("AreaProjects.run")(function* (
    tool: AreaProjectTool,
    args: Args,
    githubAccount?: string,
  ) {
    const result = yield* call(tool, args);
    if (tool === "projects_list" && Array.isArray(result.projects)) {
      const projectsWithIds = yield* Effect.forEach(result.projects as Json[], withProjectId);
      return { ...result, projects: projectsWithIds };
    }
    if (tool === "projects_get") return yield* withProjectId(result);
    if (tool === "projects_create" && result.applied === true && typeof result.path === "string") {
      const existing = yield* registered(result.path);
      if (Option.isSome(existing)) {
        if (githubAccount !== undefined) {
          return yield* fail(
            `A T3 project already uses ${result.path}. Change its account in Project Settings.`,
          );
        }
        return { ...result, t3ProjectId: existing.value.id };
      }
      const { id, commandId: created } = yield* commandId("area-project");
      const project = yield* projects
        .create({
          commandId: created,
          projectId: ProjectId.make(id),
          title: typeof result.title === "string" ? result.title : String(args.name),
          workspaceRoot: result.path,
          ...(githubAccount === undefined ? {} : { githubAccount }),
        })
        .pipe(
          Effect.mapError(() =>
            fail(
              `Created ${result.path}, but adding it to T3 failed. Add it with Add existing project.`,
            ),
          ),
        );
      return { ...result, t3ProjectId: project.id };
    }
    if (tool === "projects_update") {
      const existing = yield* registered(result.path);
      if (Option.isNone(existing)) return { ...result, t3ProjectId: null };
      const archived = result.status === "archived";
      const wasArchived = existing.value.archivedAt != null;
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
      if (wasArchived !== archived || (title !== null && title !== existing.value.title)) {
        const { commandId: updated } = yield* commandId("area-project-update");
        yield* projects
          .update({
            commandId: updated,
            projectId: existing.value.id,
            archived,
            ...(title === null ? {} : { title }),
          })
          .pipe(Effect.mapError(() => fail("Updated the project, but not its T3 entry.")));
      }
      return { ...result, t3ProjectId: existing.value.id };
    }
    return result;
  });

  const createNew = Effect.fn("AreaProjects.createNew")(function* ({
    githubAccount,
    ...input
  }: ProjectCreateNewInput & { readonly area: string }) {
    const created = yield* run("projects_create", { ...input, apply: true }, githubAccount);
    if (typeof created.t3ProjectId !== "string" || typeof created.path !== "string")
      return yield* fail("The projects tool did not create the project.");
    return {
      projectId: ProjectId.make(created.t3ProjectId),
      workspaceRoot: created.path,
      ...(typeof created.gitError === "string" ? { commitError: created.gitError } : {}),
    };
  });

  return AreaProjects.of({ run, createNew });
});

export const defaultCommand = `${NodeOS.homedir()}/.local/bin/projects`;

export const layer = (command = defaultCommand) =>
  Layer.effect(AreaProjects, make(command)).pipe(Layer.provide(ProcessRunner.layer));
