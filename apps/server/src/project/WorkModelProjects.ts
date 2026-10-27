import * as NodeOS from "node:os";
import {
  CommandId,
  ProjectId,
  type WorkModelProjectDraft,
  type WorkModelProjectOptions,
  type WorkModelProjectPreview,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as Tickets from "../tickets/TicketService.ts";
import * as ProjectService from "./ProjectService.ts";
import { readmeFrontmatter } from "./ProjectHome.ts";

const files = ["README.md", "AGENTS.md", "STATUS.md", "TOOLS.md", ".gitignore"];
const decodeInitializerOutput = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      state: Schema.Literals(["preview", "applied"]),
      slug: Schema.String,
      paths: Schema.Struct({ project: Schema.String, files: Schema.Array(Schema.String) }),
    }),
  ),
);
const reasons = {
  "invalid-area": "Choose an existing Work Model Area.",
  "invalid-home":
    "This folder is not a valid Project Home in the selected Area. Its files were preserved.",
  "existing-home":
    "This Home already exists. Review it and choose Adopt existing Home to continue.",
  "missing-home": "The Home to adopt no longer exists. Review the destination again.",
  "initializer-unavailable":
    "Project setup is unavailable on this machine. Install the existing project-init command first.",
  "initialization-failed":
    "Project initialization failed. Existing and partially created files were preserved; review the Home before trying again.",
  "registration-failed":
    "The Home is preserved, but registration did not finish. Review and adopt the existing Home to resume.",
  "origin-failed":
    "The Project exists, but recording its origin did not finish. Review and adopt the same Home with this Idea to resume.",
  "invalid-idea": "Only an open Inbox Idea can become a new Project.",
  "key-conflict":
    "This Project key already belongs to another local Home. Resolve the mapping before continuing.",
  "read-failed": "Could not read the Work Model Areas or Home on this machine.",
} as const;
export class WorkModelProjectError extends Schema.TaggedError<WorkModelProjectError>()(
  "WorkModelProjectError",
  {
    reason: Schema.Literals(
      Object.keys(reasons) as [keyof typeof reasons, ...(keyof typeof reasons)[]],
    ),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return reasons[this.reason];
  }
}

export class WorkModelProjects extends Context.Service<
  WorkModelProjects,
  {
    readonly options: Effect.Effect<WorkModelProjectOptions, WorkModelProjectError>;
    readonly preview: (
      input: WorkModelProjectDraft,
    ) => Effect.Effect<WorkModelProjectPreview, WorkModelProjectError>;
    readonly create: (
      input: WorkModelProjectDraft,
    ) => Effect.Effect<
      { readonly projectId: ProjectId; readonly workspaceRoot: string },
      WorkModelProjectError
    >;
  }
>()("t3/project/WorkModelProjects") {}

const make = Effect.fn("make")(function* (settings: {
  readonly projectsRoot: string;
  readonly initializer: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const projects = yield* ProjectService.ProjectService;
  const tickets = yield* Tickets.TicketService;
  // ponytail: setup is infrequent; serialize it so Homes, keys and Idea origins cannot race.
  const lock = yield* Semaphore.make(1);
  const root = path.resolve(settings.projectsRoot);
  const isWorkModelError = Schema.is(WorkModelProjectError);
  const encodeSpec = Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        name: Schema.String,
        slug: Schema.String,
        purpose: Schema.String,
        area: Schema.String,
        project_root: Schema.String,
        obsidian_vault: Schema.Null,
        goal: Schema.optionalKey(Schema.String),
      }),
    ),
  );
  const fail = (reason: keyof typeof reasons, workspaceRoot?: string, cause?: unknown) =>
    new WorkModelProjectError({
      reason,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(cause === undefined ? {} : { cause }),
    });
  const metadata = (file: string) => fs.readFileString(file).pipe(Effect.map(readmeFrontmatter));
  const options = Effect.gen(function* () {
    const areas: WorkModelProjectOptions["areas"][number][] = [];
    if (yield* fs.exists(root)) {
      for (const name of (yield* fs.readDirectory(root)).toSorted()) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
        const file = path.join(root, name, "AREA.md");
        if (!(yield* fs.exists(file))) continue;
        const area = yield* metadata(file);
        if (area.area === name && (area.scope === "personal" || area.scope === "company"))
          areas.push({ name, scope: area.scope });
      }
    }
    return {
      projectsRoot: root,
      initializerAvailable: yield* fs.exists(settings.initializer),
      areas,
    };
  }).pipe(Effect.mapError((cause) => fail("read-failed", undefined, cause)));

  const initialize = (input: WorkModelProjectDraft, apply: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (!(yield* fs.exists(settings.initializer)))
          return yield* fail("initializer-unavailable");
        const spec = yield* fs.makeTempFileScoped({
          prefix: "t3-project-init-",
          suffix: ".json",
        });
        const specText = yield* encodeSpec({
          name: input.name,
          slug: input.slug,
          purpose: input.purpose,
          area: input.area,
          project_root: root,
          obsidian_vault: null,
          ...(input.goal ? { goal: input.goal } : {}),
        });
        yield* fs.writeFileString(spec, specText, { mode: 0o600 });
        const output = yield* runner.run({
          command: settings.initializer,
          args: ["--spec", spec, ...(apply ? ["--apply"] : [])],
          timeout: "30 seconds",
          maxOutputBytes: 64 * 1024,
        });
        if (output.code !== 0)
          return yield* fail("initialization-failed", path.join(root, input.area, input.slug));
        const result = yield* decodeInitializerOutput(output.stdout);
        const expected = path.join(yield* fs.realPath(path.join(root, input.area)), input.slug);
        if (
          result.state !== (apply ? "applied" : "preview") ||
          result.slug !== input.slug ||
          path.resolve(result.paths.project) !== expected ||
          files.some((file) => !result.paths.files.includes(path.join(expected, file)))
        )
          return yield* fail("initialization-failed", expected);
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isWorkModelError(cause)
          ? cause
          : fail("initialization-failed", path.join(root, input.area, input.slug), cause),
      ),
    );

  const preview = Effect.fn("preview")(
    function* (input: WorkModelProjectDraft) {
      const available = yield* options;
      const area = available.areas.find((candidate) => candidate.name === input.area);
      if (!area || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 64)
        return yield* fail("invalid-area");
      const workspaceRoot = path.join(root, input.area, input.slug);
      const existingHome = yield* fs.exists(workspaceRoot);
      let identity = input.slug;
      if (existingHome) {
        const home = yield* metadata(path.join(workspaceRoot, "README.md"));
        const git = yield* runner.run({
          command: "git",
          args: ["-C", workspaceRoot, "rev-parse", "--show-toplevel"],
          timeout: "10 seconds",
        });
        if (
          !home.id ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(home.id) ||
          home.area !== input.area ||
          home.area_repo === "true" ||
          git.code !== 0 ||
          path.resolve(git.stdout.trim()) !== (yield* fs.realPath(workspaceRoot))
        )
          return yield* fail("invalid-home", workspaceRoot);
        identity = home.id;
      } else {
        if (input.adoptExisting) return yield* fail("missing-home", workspaceRoot);
        yield* initialize(input, false);
      }
      const registered = existingHome
        ? yield* projects.getByWorkspaceRoot(workspaceRoot)
        : Option.none();
      const registry = (yield* tickets.projectsList).projects;
      const oldMapping = Option.isSome(registered)
        ? registry.find((entry) => entry.projectId === registered.value.id)
        : undefined;
      const key = oldMapping?.key ?? identity;
      const conflict = registry.find(
        (entry) =>
          entry.key === key &&
          entry.projectId !== null &&
          entry.projectId !== (Option.isSome(registered) ? registered.value.id : null),
      );
      if (conflict) return yield* fail("key-conflict", workspaceRoot);
      if (input.sourceIdeaId) {
        const origin = yield* tickets.get(input.sourceIdeaId);
        const alreadyRecorded =
          Option.isSome(registered) &&
          origin.decisions.some((entry) =>
            entry.text.startsWith(`[Project origin ${registered.value.id}]`),
          );
        if (
          origin.ticket.deletedAt !== null ||
          (origin.ticket.status !== "inbox" &&
            !(
              alreadyRecorded &&
              origin.ticket.status === "done" &&
              origin.ticket.projectId === registered.value.id
            ))
        )
          return yield* fail("invalid-idea", workspaceRoot);
      }
      return {
        workspaceRoot,
        projectIdentity: identity,
        projectKey: key,
        scope: area.scope,
        existingHome,
        registeredProjectId: Option.isSome(registered) ? registered.value.id : null,
        files: files.map((file) => path.join(workspaceRoot, file)),
      };
    },
    Effect.mapError((cause) =>
      isWorkModelError(cause) ? cause : fail("read-failed", undefined, cause),
    ),
  );

  const create = (input: WorkModelProjectDraft) =>
    lock.withPermit(
      Effect.gen(function* () {
        const checked = yield* preview(input);
        if (checked.existingHome && !input.adoptExisting)
          return yield* fail("existing-home", checked.workspaceRoot);
        if (!checked.existingHome) yield* initialize(input, true);
        const identity = `${input.area}:${input.slug}`;
        const { project } = yield* projects
          .bootstrap({
            commandId: CommandId.make(`work-model:create:${identity}`),
            projectId: ProjectId.make(`work-model:${identity}`),
            title: input.name,
            workspaceRoot: checked.workspaceRoot,
          })
          .pipe(
            Effect.mapError((cause) => fail("registration-failed", checked.workspaceRoot, cause)),
          );
        yield* tickets
          .projectsMap({
            key: checked.projectKey,
            projectId: project.id,
            displayName: project.title,
          })
          .pipe(
            Effect.mapError((cause) => fail("registration-failed", checked.workspaceRoot, cause)),
          );
        if (input.sourceIdeaId) {
          const requestId = `project-origin:${project.id}:${input.sourceIdeaId}`;
          yield* Effect.gen(function* () {
            const origin = yield* tickets.get(input.sourceIdeaId!);
            const author = tickets.author({ actor: "user" });
            const text = `[Project origin ${project.id}] Established ${project.title} (${checked.projectKey}) at ${checked.workspaceRoot}. This Idea is the Project's origin; create a separate actionable first Ticket.`;
            yield* tickets.entry(
              {
                id: input.sourceIdeaId!,
                kind: "decision",
                text,
                clientRequestId: requestId,
              },
              author,
              "work-model-projects",
            );
            for (const question of origin.questions)
              yield* tickets.entry(
                {
                  id: input.sourceIdeaId!,
                  kind: "result",
                  text: `Resolved by establishing Project ${project.title} (${checked.projectKey}).`,
                  resolves: question.eventId,
                  clientRequestId: `${requestId}:${question.eventId}`,
                },
                author,
                "work-model-projects",
              );
            yield* tickets.upsert(
              {
                id: input.sourceIdeaId!,
                requireExisting: true,
                projectId: project.id,
                status: "done",
                commandId: CommandId.make(`${requestId}:close`),
              },
              author,
            );
          }).pipe(Effect.mapError((cause) => fail("origin-failed", checked.workspaceRoot, cause)));
        }
        return { projectId: project.id, workspaceRoot: checked.workspaceRoot };
      }),
    );
  return WorkModelProjects.of({ options, preview, create });
});

// Paths are server-local. Tests supply disposable Areas and the real initializer.
export const layer = (settings?: { readonly projectsRoot: string; readonly initializer: string }) =>
  Layer.effect(
    WorkModelProjects,
    make(
      settings ?? {
        projectsRoot: `${NodeOS.homedir()}/Projects`,
        initializer: `${NodeOS.homedir()}/.local/bin/project-init`,
      },
    ),
  );
