import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as AreaProjects from "./AreaProjects.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "./ProjectService.ts";

// A stand-in `projects` command: replies with the JSON the test gives each tool.
const fakeCommand = (replies: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "area-projects-" });
    const command = `${dir}/projects`;
    yield* fs.writeFileString(
      command,
      `#!/usr/bin/env python3\nimport json, sys\nreplies = json.loads(${JSON.stringify(
        JSON.stringify(replies),
      )})\nreply = replies[sys.argv[2]]\nprint(json.dumps(reply))\nsys.exit(1 if "error" in reply else 0)\n`,
    );
    yield* fs.chmod(command, 0o755);
    return command;
  });

const project = (id: string, workspaceRoot: string, archived = false) =>
  ({
    id: ProjectId.make(id),
    title: "Tiny Game",
    workspaceRoot,
    archivedAt: archived ? "2026-11-23T00:00:00.000Z" : null,
  }) as unknown as Project;

const run = (
  command: string,
  projects: Partial<ProjectService.ProjectService["Service"]>,
  tool: AreaProjects.AreaProjectTool,
  args: Record<string, unknown>,
) =>
  AreaProjects.AreaProjects.pipe(
    Effect.flatMap((service) => service.run(tool, args)),
    Effect.provide(
      Layer.effect(AreaProjects.AreaProjects, AreaProjects.make(command)).pipe(
        Layer.provide(Layer.mock(ProjectService.ProjectService)(projects)),
        Layer.provide(ProcessRunner.layer),
      ),
    ),
  );

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.live("sets the chosen GitHub account when creating an Area project", () =>
  Effect.gen(function* () {
    const command = yield* fakeCommand({
      projects_create: { applied: true, path: "/p/creative/tiny-game" },
    });
    const created: ProjectService.ProjectCreateInput[] = [];
    const service = yield* AreaProjects.AreaProjects.pipe(
      Effect.provide(
        Layer.effect(AreaProjects.AreaProjects, AreaProjects.make(command)).pipe(
          Layer.provide(
            Layer.mock(ProjectService.ProjectService)({
              getByWorkspaceRoot: () => Effect.succeedNone,
              create: (input) =>
                Effect.sync(() => {
                  created.push(input);
                  return project(input.projectId, input.workspaceRoot);
                }),
            }),
          ),
          Layer.provide(ProcessRunner.layer),
        ),
      ),
    );
    const result = yield* service.createNew({
      area: "creative",
      name: "Tiny Game",
      githubAccount: "work",
    });
    assert.equal(created[0]?.projectId, result.projectId);
    assert.equal(created[0]?.githubAccount, "work");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("adds a created Area project to T3 with its folder and title", () =>
  Effect.gen(function* () {
    const command = yield* fakeCommand({
      projects_create: {
        applied: true,
        ref: "creative/tiny-game",
        title: "Tiny Game",
        path: "/p/creative/tiny-game",
      },
    });
    const created: Array<{ title: string; workspaceRoot: string }> = [];
    const result = yield* run(
      command,
      {
        getByWorkspaceRoot: () => Effect.succeedNone,
        create: (input) => {
          created.push({ title: input.title, workspaceRoot: input.workspaceRoot });
          return Effect.succeed(project(input.projectId, input.workspaceRoot));
        },
      },
      "projects_create",
      { area: "creative", name: "Tiny Game", purpose: "Fun.", apply: true },
    );
    assert.deepStrictEqual(created, [
      { title: "Tiny Game", workspaceRoot: "/p/creative/tiny-game" },
    ]);
    assert.strictEqual(typeof result.t3ProjectId, "string");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("a preview adds nothing to T3", () =>
  Effect.gen(function* () {
    const command = yield* fakeCommand({
      projects_create: { applied: false, path: "/p/creative/tiny-game" },
    });
    const result = yield* run(
      command,
      { create: () => Effect.die("must not register a preview") },
      "projects_create",
      { area: "creative", name: "Tiny Game", purpose: "Fun." },
    );
    assert.strictEqual(result.applied, false);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("archiving and restoring an Area project archives and restores its T3 project", () =>
  Effect.gen(function* () {
    const updates: Array<boolean | undefined> = [];
    const registered = (archived: boolean) => ({
      getByWorkspaceRoot: () => Effect.succeedSome(project("p1", "/p/systems/legacy", archived)),
      update: (input: { readonly archived?: boolean | undefined }) => {
        updates.push(input.archived);
        return Effect.succeed(project("p1", "/p/systems/legacy", input.archived === true));
      },
    });
    const archive = yield* fakeCommand({
      projects_update: { status: "archived", path: "/p/systems/legacy" },
    });
    const result = yield* run(archive, registered(false), "projects_update", {
      project: "legacy",
      status: "archived",
    });
    const restore = yield* fakeCommand({
      projects_update: { status: "active", path: "/p/systems/legacy" },
    });
    yield* run(restore, registered(true), "projects_update", {
      project: "legacy",
      status: "active",
    });
    yield* run(restore, registered(false), "projects_update", { project: "legacy", goal: "x" });
    assert.deepStrictEqual(updates, [true, false]);
    assert.strictEqual(result.t3ProjectId, "p1");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("reports the projects tool's own error, and a missing install", () =>
  Effect.gen(function* () {
    const command = yield* fakeCommand({
      projects_create: { error: "'x' is not an Area. Only Nick creates Areas." },
    });
    const refused = yield* run(command, {}, "projects_create", { area: "x" }).pipe(Effect.flip);
    assert.strictEqual(refused.message, "'x' is not an Area. Only Nick creates Areas.");
    const missing = yield* run("/nonexistent/projects", {}, "projects_areas", {}).pipe(Effect.flip);
    assert.include(missing.message, "not installed on this machine");
  }).pipe(Effect.scoped, Effect.provide(services)),
);
