import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type WorkModelProjectDraft } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Tickets from "../tickets/TicketService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichment from "./ProjectEnrichmentService.ts";
import * as ProjectFavicon from "./ProjectFaviconResolver.ts";
import * as RepositoryIdentity from "./RepositoryIdentityResolver.ts";
import * as Projects from "./ProjectService.ts";
import * as WorkModel from "./WorkModelProjects.ts";

const draft: WorkModelProjectDraft = {
  name: "Fixture Project",
  area: "systems",
  slug: "fixture-project",
  purpose: "Verify Project creation",
  goal: "A verified Home",
  adoptExisting: false,
};
const fixture = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const spec = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--spec')+1], 'utf8'));
const home = path.join(fs.realpathSync(path.join(spec.project_root,spec.area)),spec.slug);
const files=['README.md','AGENTS.md','STATUS.md','TOOLS.md','.gitignore'];
if(process.argv.includes('--apply')){
 fs.mkdirSync(home);
 for(const name of files)fs.writeFileSync(path.join(home,name),name==='README.md'?'---\\nid: '+spec.slug+'\\narea: '+spec.area+'\\n---\\n# '+spec.name: '# Fixture '+name,{flag:'wx'});
 const git=cp.spawnSync('git',['init','--initial-branch=main',home],{encoding:'utf8'});if(git.status!==0)process.exit(1);
}
console.log(JSON.stringify({state:process.argv.includes('--apply')?'applied':'preview',slug:spec.slug,paths:{project:home,files:files.map(f=>path.join(home,f))}}));
`;

const withHome = <A, E>(
  body: (data: {
    root: string;
    initializer: string;
  }) => Effect.Effect<
    A,
    E,
    | WorkModel.WorkModelProjects
    | Projects.ProjectService
    | Tickets.TicketService
    | NodeServices.NodeServices
    | SqlClient.SqlClient
  >,
  failRegistration = false,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-work-model-project-" });
    const root = path.join(base, "Projects");
    yield* fs.makeDirectory(path.join(root, "systems"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "systems", "AREA.md"),
      "---\narea: systems\nscope: personal\n---\n",
    );
    const initializer =
      process.env.T3_WORK_MODEL_TEST_INITIALIZER ?? path.join(base, "project-init");
    if (!process.env.T3_WORK_MODEL_TEST_INITIALIZER)
      yield* fs.writeFileString(initializer, fixture, { mode: 0o700 });
    let failOnce = failRegistration;
    const baseLayer = RuntimeLayer.layerProjectService.pipe(
      Layer.provideMerge(ProjectEnrichment.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          WorkspacePaths.layer,
          Layer.succeed(RepositoryIdentity.RepositoryIdentityResolver, {
            resolve: () => Effect.succeed(null),
          }),
          Layer.succeed(ProjectFavicon.ProjectFaviconResolver, {
            resolvePath: () => Effect.succeed(null),
          }),
        ),
      ),
      Layer.provideMerge(ProjectStore.layer),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(ServerConfig.layerTest(base, base)),
    );
    const projectLayer = failRegistration
      ? Layer.effect(
          Projects.ProjectService,
          Projects.ProjectService.pipe(
            Effect.map((service) => ({
              ...service,
              bootstrap: (input) => {
                if (failOnce) {
                  failOnce = false;
                  return Effect.fail(
                    new Projects.ProjectOperationError({
                      operation: "dispatch-project-command",
                      cause: "fixture failure",
                    }),
                  );
                }
                return service.bootstrap(input);
              },
            })),
          ),
        ).pipe(Layer.provideMerge(baseLayer))
      : baseLayer;
    return yield* body({ root, initializer }).pipe(
      Effect.provide(
        WorkModel.layer({ projectsRoot: root, initializer }).pipe(
          Layer.provideMerge(Tickets.layer),
          Layer.provideMerge(projectLayer),
          Layer.provideMerge(ProcessRunner.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("previews without writes, creates standard Home and key, and starts no thread", () =>
  withHome(({ root }) =>
    Effect.gen(function* () {
      const service = yield* WorkModel.WorkModelProjects,
        fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path,
        projects = yield* Projects.ProjectService,
        tickets = yield* Tickets.TicketService,
        sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual((yield* service.options).areas, [
        { name: "systems", scope: "personal" },
      ]);
      const preview = yield* service.preview(draft);
      assert.isFalse(preview.existingHome);
      assert.isFalse(yield* fs.exists(preview.workspaceRoot));
      const created = yield* service.create(draft);
      assert.equal(created.workspaceRoot, path.join(root, "systems", draft.slug));
      for (const name of ["README.md", "AGENTS.md", "STATUS.md", "TOOLS.md", ".gitignore", ".git"])
        assert.isTrue(yield* fs.exists(path.join(created.workspaceRoot, name)));
      assert.isTrue(
        (yield* fs.readFileString(path.join(created.workspaceRoot, "README.md"))).includes(
          "area: systems",
        ),
      );
      assert.equal((yield* projects.snapshot).projects.length, 1);
      assert.equal(
        (yield* tickets.projectsList).projects.find((p) => p.key === draft.slug)?.projectId,
        created.projectId,
      );
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
        0,
      );
    }),
  ),
);

it.effect("requires explicit adoption and preserves files, existing key and Project identity", () =>
  withHome(() =>
    Effect.gen(function* () {
      const service = yield* WorkModel.WorkModelProjects,
        fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path,
        tickets = yield* Tickets.TicketService,
        projects = yield* Projects.ProjectService;
      const created = yield* service.create(draft);
      const before = yield* fs.readFileString(path.join(created.workspaceRoot, "README.md"));
      yield* fs.writeFileString(path.join(created.workspaceRoot, "unrelated.txt"), "preserved WIP");
      yield* tickets.projectsMap({ key: "original-key", projectId: created.projectId });
      // Unmap the unused alias, matching an already moved Home.
      yield* tickets.projectsMap({ key: draft.slug, projectId: null });
      const rejected = yield* Effect.flip(service.create(draft));
      assert.equal(rejected.reason, "existing-home");
      const preview = yield* service.preview({ ...draft, adoptExisting: true });
      assert.equal(preview.projectKey, "original-key");
      const adopted = yield* service.create({
        ...draft,
        adoptExisting: true,
        purpose: "No rewrite",
      });
      assert.equal(adopted.projectId, created.projectId);
      assert.equal((yield* projects.snapshot).projects.length, 1);
      assert.equal(yield* fs.readFileString(path.join(created.workspaceRoot, "README.md")), before);
      assert.equal(
        yield* fs.readFileString(path.join(created.workspaceRoot, "unrelated.txt")),
        "preserved WIP",
      );
    }),
  ),
);

it.effect(
  "closes source Idea as origin, resolves its question, and creates no first work Ticket",
  () =>
    withHome(() =>
      Effect.gen(function* () {
        const service = yield* WorkModel.WorkModelProjects,
          tickets = yield* Tickets.TicketService;
        const source = (yield* tickets.upsert({
          title: "A new Project",
          projectId: null,
          createdBy: "user",
        })).ticket;
        yield* tickets.entry({
          id: source.id,
          kind: "decision",
          text: "Keep the original scope decision.",
          clientRequestId: "original-decision",
        });
        yield* tickets.entry({
          id: source.id,
          kind: "question",
          text: "Create a Project?",
          clientRequestId: "question",
        });
        const created = yield* service.create({ ...draft, sourceIdeaId: source.id });
        const state = yield* tickets.get(source.id);
        assert.equal(state.ticket.status, "done");
        assert.equal(state.ticket.projectId, created.projectId);
        assert.equal(state.questions.length, 0);
        assert.equal(state.decisions.length, 2);
        assert.isTrue(state.decisions.some((entry) => entry.text.includes("Project origin")));
        assert.isTrue(
          state.decisions.some((entry) => entry.text === "Keep the original scope decision."),
        );
        assert.equal((yield* tickets.list()).tickets.length, 1);
        const again = yield* service.create({
          ...draft,
          sourceIdeaId: source.id,
          adoptExisting: true,
        });
        assert.equal(again.projectId, created.projectId);
        assert.equal((yield* tickets.get(source.id)).decisions.length, 2);
      }),
    ),
);

it.effect("preserves a created Home on registration failure and recovers through adoption", () =>
  withHome(
    () =>
      Effect.gen(function* () {
        const service = yield* WorkModel.WorkModelProjects,
          fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path,
          projects = yield* Projects.ProjectService;
        const failed = yield* Effect.flip(service.create(draft));
        assert.equal(failed.reason, "registration-failed");
        assert.isTrue(yield* fs.exists(path.join(failed.workspaceRoot!, "README.md")));
        const recovered = yield* service.create({ ...draft, adoptExisting: true });
        assert.equal((yield* projects.snapshot).projects.length, 1);
        assert.equal(recovered.workspaceRoot, failed.workspaceRoot);
      }),
    true,
  ),
);

it.effect("closes each Idea independently when adopting the same Project", () =>
  withHome(() =>
    Effect.gen(function* () {
      const service = yield* WorkModel.WorkModelProjects,
        tickets = yield* Tickets.TicketService;
      const first = (yield* tickets.upsert({ title: "First origin", projectId: null })).ticket;
      const second = (yield* tickets.upsert({ title: "Second origin", projectId: null })).ticket;
      const created = yield* service.create({ ...draft, sourceIdeaId: first.id });
      const adopted = yield* service.create({
        ...draft,
        sourceIdeaId: second.id,
        adoptExisting: true,
      });
      assert.equal(adopted.projectId, created.projectId);
      for (const id of [first.id, second.id]) {
        const record = yield* tickets.get(id);
        assert.equal(record.ticket.status, "done");
        assert.equal(record.ticket.projectId, created.projectId);
        assert.equal(record.decisions.length, 1);
      }
      yield* service.create({ ...draft, sourceIdeaId: second.id, adoptExisting: true });
      assert.equal((yield* tickets.get(second.id)).decisions.length, 1);
    }),
  ),
);

it.effect("rejects unknown Areas and escaping slugs before touching the filesystem", () =>
  withHome(() =>
    Effect.gen(function* () {
      const service = yield* WorkModel.WorkModelProjects;
      assert.equal(
        (yield* Effect.flip(service.create({ ...draft, area: "unknown" }))).reason,
        "invalid-area",
      );
      assert.equal(
        (yield* Effect.flip(service.create({ ...draft, slug: "../escape" }))).reason,
        "invalid-area",
      );
    }),
  ),
);

it.effect("preserves an invalid existing folder and rejects a missing adoption target", () =>
  withHome(({ root }) =>
    Effect.gen(function* () {
      const service = yield* WorkModel.WorkModelProjects,
        fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      assert.equal(
        (yield* Effect.flip(service.create({ ...draft, adoptExisting: true }))).reason,
        "missing-home",
      );
      const home = path.join(root, draft.area, draft.slug);
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(path.join(home, "README.md"), "user-owned content");
      yield* Effect.flip(service.create({ ...draft, adoptExisting: true }));
      assert.equal(yield* fs.readFileString(path.join(home, "README.md")), "user-owned content");
    }),
  ),
);

it.effect("rejects a mapped key conflict and a non-Idea before creating a Home", () =>
  withHome(({ root }) =>
    Effect.gen(function* () {
      const service = yield* WorkModel.WorkModelProjects,
        tickets = yield* Tickets.TicketService,
        fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const other = yield* service.create({ ...draft, slug: "another-home" });
      yield* tickets.projectsMap({ key: draft.slug, projectId: other.projectId });
      assert.equal((yield* Effect.flip(service.create(draft))).reason, "key-conflict");
      yield* tickets.projectsMap({ key: draft.slug, projectId: null });
      const ticket = (yield* tickets.upsert({
        title: "Existing work",
        status: "ready",
        projectId: null,
      })).ticket;
      assert.equal(
        (yield* Effect.flip(service.create({ ...draft, sourceIdeaId: ticket.id }))).reason,
        "invalid-idea",
      );
      assert.isFalse(yield* fs.exists(path.join(root, draft.area, draft.slug)));
    }),
  ),
);

it.effect("serializes repeated creation without duplicating a Home or Project", () =>
  withHome(() =>
    Effect.gen(function* () {
      const service = yield* WorkModel.WorkModelProjects,
        projects = yield* Projects.ProjectService;
      const results = yield* Effect.all(
        [service.create(draft).pipe(Effect.result), service.create(draft).pipe(Effect.result)],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal(
        results.filter(
          (result) => result._tag === "Failure" && result.failure.reason === "existing-home",
        ).length,
        1,
      );
      assert.equal((yield* projects.snapshot).projects.length, 1);
    }),
  ),
);

it.effect("allows one Idea to originate only one concurrently created Project", () =>
  withHome(() =>
    Effect.gen(function* () {
      const service = yield* WorkModel.WorkModelProjects,
        tickets = yield* Tickets.TicketService,
        projects = yield* Projects.ProjectService;
      const idea = (yield* tickets.upsert({ title: "One Project", projectId: null })).ticket;
      const results = yield* Effect.all(
        [
          service.create({ ...draft, sourceIdeaId: idea.id }).pipe(Effect.result),
          service
            .create({ ...draft, slug: "second-home", sourceIdeaId: idea.id })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((r) => r._tag === "Success").length, 1);
      assert.equal(
        results.filter((r) => r._tag === "Failure" && r.failure.reason === "invalid-idea").length,
        1,
      );
      assert.equal((yield* projects.snapshot).projects.length, 1);
      assert.equal((yield* tickets.get(idea.id)).decisions.length, 1);
    }),
  ),
);
