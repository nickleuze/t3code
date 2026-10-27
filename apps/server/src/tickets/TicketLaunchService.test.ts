import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TicketId,
  type Project,
  type OrchestrationV2ThreadShell,
  type TicketStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launches from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Defaults from "../project/ProjectLaunchDefaults.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Tickets from "./TicketService.ts";
import * as Start from "./TicketLaunchService.ts";
import { applyGoalCommand, goalSummary } from "../orchestration-v2/GoalState.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
const PROJECT = ProjectId.make("project:mcp-test");
const makeHarness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ticket-brief-" });
  const home = path.join(root, "Projects", "systems", "fixture");
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.writeFileString(
    path.join(home, "README.md"),
    "---\nid: fixture\narea: systems\n---\nProject context.",
  );
  yield* fs.writeFileString(path.join(home, "STATUS.md"), "Current project state.");
  yield* fs.writeFileString(
    path.join(home, "..", "AREA.md"),
    "---\narea: systems\nscope: personal\n---\n",
  );
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const records = new Map<ThreadId, ReturnType<typeof idleThreadProjection>>();
  const calls: Launches.ThreadLaunchInput[] = [];
  const goals: Array<Parameters<Threads.ThreadManagementService["Service"]["dispatch"]>[0]> = [];
  const template = liveThreadShell(ThreadId.make("template"));
  let project = {
    id: PROJECT,
    title: "Fixture",
    workspaceRoot: home,
    defaultModelSelection: template.modelSelection,
    defaultThreadEnvMode: null,
  } as Project;
  let ticketService: Tickets.TicketService["Service"];
  let failure: "reject" | "ambiguous" | undefined;
  let envMode = "worktree";
  let repository = true;
  let headCommit = true;
  const deniedReads = new Set<string>();
  const dependencies = Layer.mergeAll(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: () => Effect.succeed(repository),
      hasCommit: () => Effect.succeed(headCommit),
    }),
    Layer.mock(Receipts.CommandReceiptStoreV2)({
      getByCommandId: (commandId) =>
        Effect.succeedSome({
          commandId,
          threadId: ThreadId.make(commandId),
          commandType: "thread.create",
          status: "accepted",
        } as Receipts.CommandReceiptV2),
    }),
    NodeServices.layer,
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeedSome({
          projectId: project.id,
          title: "Fixture",
          workspaceRoot: project.workspaceRoot,
          deletedAt: null,
        } as ProjectStore.ProjectRow),
      list: () => Effect.succeed([]),
    }),
    Layer.mock(Projects.ProjectService)({
      getById: (id) => (id === project.id ? Effect.succeedSome(project) : Effect.succeedNone),
    }),
    Layer.mock(Defaults.ProjectLaunchDefaults)({
      resolve: () =>
        Effect.succeed({
          modelSelection: project.defaultModelSelection!,
          runtimeMode: "auto",
          envMode: envMode as "local" | "worktree",
        }),
      runtimeMode: (mode) => Effect.succeed(mode),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: (id) =>
        Effect.succeed(records.get(id) ?? idleThreadProjection(shells.get(id)!)),
      getThreadShell: (id) => Effect.sync(() => shells.get(id) ?? null),
      dispatch: (command) =>
        Effect.sync(() => {
          goals.push(command);
          return {} as never;
        }),
    }),
    Layer.mock(Launches.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          // The actual TicketService must have persisted the work link first.
          const linked = (yield* ticketService.list().pipe(Effect.orDie)).tickets.find((t) =>
            t.links.some((l) => l.threadId === input.threadId),
          );
          expect(linked?.links.find((l) => l.threadId === input.threadId)?.role).toBe("work");
          if (failure === "reject")
            return yield* new Launches.ThreadLaunchError({
              commandId: input.commandId,
              projectId: PROJECT,
              operation: "resolve-project",
              cause: "fixture",
            });
          const shell = {
            ...liveThreadShell(input.threadId!),
            projectId: input.projectId!,
            title: input.title,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            modelSelection: input.modelSelection,
          };
          shells.set(shell.id, shell);
          if (failure === "ambiguous")
            return yield* new Launches.ThreadLaunchError({
              commandId: input.commandId,
              projectId: PROJECT,
              operation: "create-thread",
              cause: "response lost",
            });
          return {
            threadId: shell.id,
            projection: idleThreadProjection(shell),
            resumed: calls.length > 1,
          };
        }),
    }),
  );
  // The launch test double accesses the real ticket service in its captured context.
  const ticketsLayer = Tickets.layer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provide(Sqlite.layerMemory),
  );
  const context = yield* Layer.build(ticketsLayer);
  const tickets = yield* Tickets.TicketService.pipe(Effect.provideContext(context));
  ticketService = tickets;
  const launches = yield* Start.TicketLaunchService.pipe(
    Effect.provide(Start.layer),
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      access: (file, options) =>
        deniedReads.has(file)
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "access",
                pathOrDescriptor: file,
              }),
            )
          : fs.access(file, options),
    }),
    Effect.provideContext(context),
  );
  const create = (assigned = true) =>
    tickets.upsert({ title: "Launch fixture", ...(assigned ? { projectId: project.id } : {}) });
  const input = (ticketId: TicketId, id = "launch"): TicketStartInput => ({
    ticketId,
    threadId: ThreadId.make(id),
    commandId: CommandId.make(id),
    creationSource: "web",
  });
  return {
    tickets,
    launches,
    create,
    input,
    calls,
    goals,
    shells,
    records,
    fs,
    path,
    root,
    home,
    deniedReads,
    setProject: (value: Partial<Project>) => {
      project = { ...project, ...value };
    },
    setFailure: (value: typeof failure) => {
      failure = value;
    },
    setEnvMode: (value: string) => {
      envMode = value;
    },
    setGit: (isRepository: boolean, hasCommit = true) => {
      repository = isRepository;
      headCommit = hasCommit;
    },
  };
}).pipe(Effect.provide(NodeServices.layer));

it.effect(
  "plan uses a work link, project defaults and a HEAD worktree; retry keeps one thread",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const { ticket } = yield* h.create();
      const result = yield* h.launches.start(h.input(ticket.id));
      expect(result.interactionMode).toBe("plan");
      expect(h.calls[0]?.workspaceStrategy).toMatchObject({ type: "worktree", baseRef: "HEAD" });
      expect(h.calls[0]?.initialMessage?.text).toContain(`T3 ticket ${ticket.id}`);
      expect((yield* h.tickets.get(ticket.id)).ticket.links[0]?.role).toBe("work");
      expect(yield* h.launches.start(h.input(ticket.id))).toEqual(result);
      expect(h.shells.size).toBe(1);
    }).pipe(Effect.scoped),
);
it.effect("missing ticket and missing project have typed errors; picker assigns a project", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    expect(
      (yield* h.launches.start(h.input(TicketId.make("missing"))).pipe(Effect.flip))._tag,
    ).toBe("TicketNotFound");
    const { ticket } = yield* h.create(false);
    expect((yield* h.launches.start(h.input(ticket.id)).pipe(Effect.flip))._tag).toBe(
      "TicketLaunchNeedsProject",
    );
    yield* h.launches.start({ ...h.input(ticket.id), projectId: PROJECT });
    expect((yield* h.tickets.get(ticket.id)).ticket.projectId).toBe(PROJECT);
  }).pipe(Effect.scoped),
);
it.effect("picker maps an existing shared project key on this machine", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const { ticket } = yield* h.tickets.upsert({ title: "Shared", projectKey: "shared" });
    yield* h.launches.start({ ...h.input(ticket.id), projectId: PROJECT });
    expect((yield* h.tickets.get(ticket.id)).ticket.projectId).toBe(PROJECT);
  }).pipe(Effect.scoped),
);
it.effect(
  "active work blocks another launch unless allowParallel; foreign-machine links do not",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const { ticket } = yield* h.create();
      yield* h.launches.start(h.input(ticket.id));
      expect((yield* h.launches.start(h.input(ticket.id, "second"))).status).toBe("already_active");
      expect(h.calls.length).toBe(1);
      yield* h.launches.start({ ...h.input(ticket.id, "second"), allowParallel: true });
      expect(h.calls.length).toBe(2);
      expect(h.calls[0]?.workspaceStrategy).not.toEqual(h.calls[1]?.workspaceStrategy);
    }).pipe(Effect.scoped),
);
it.effect("pending user input and proposed plans remain active after a run stops", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const { ticket } = yield* h.create();
    yield* h.launches.start(h.input(ticket.id));
    const shell = h.shells.get(ThreadId.make("launch"))!;
    h.shells.set(shell.id, {
      ...shell,
      status: "idle",
      activeRunId: null,
      hasActionableProposedPlan: true,
    });
    expect((yield* h.launches.start(h.input(ticket.id, "second"))).status).toBe("already_active");
  }).pipe(Effect.scoped),
);
it.effect("goal launches without an initial message and dedupes its goal command", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    h.setEnvMode("local");
    const { ticket } = yield* h.create();
    yield* h.launches.start({ ...h.input(ticket.id), mode: "goal" });
    expect(h.calls[0]?.initialMessage).toBeUndefined();
    expect(h.calls[0]?.workspaceStrategy).toEqual({ type: "root" });
    expect(h.goals[0]).toMatchObject({
      commandId: "ticket-goal:launch",
      type: "thread.goal.set",
      objective: expect.stringContaining(ticket.title),
    });
  }).pipe(Effect.scoped),
);
it.effect("definite rejection unlinks; ambiguous creation preserves the link and retry ids", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const { ticket } = yield* h.create();
    h.setFailure("reject");
    yield* h.launches.start(h.input(ticket.id)).pipe(Effect.flip);
    expect((yield* h.tickets.get(ticket.id)).ticket.links).toEqual([]);
    h.setFailure("ambiguous");
    yield* h.launches.start(h.input(ticket.id)).pipe(Effect.flip);
    expect((yield* h.tickets.get(ticket.id)).ticket.links.length).toBe(1);
    h.setFailure(undefined);
    yield* h.launches.start(h.input(ticket.id));
    expect(h.calls.map((c) => c.commandId)).toEqual(["launch", "launch", "launch"]);
    expect(h.shells.size).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("foreign-machine work does not block a local launch", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const { ticket } = yield* h.create();
    const foreignId = ThreadId.make("foreign");
    h.shells.set(foreignId, liveThreadShell(foreignId));
    yield* h.tickets.importEvents([
      {
        eventId: "foreign-link",
        ticketId: ticket.id,
        at: "2099-01-01T00:00:00.000Z",
        by: { actor: "agent", machine: "other" },
        type: "link",
        kind: "thread",
        ref: foreignId,
        role: "work",
        machine: "other",
      },
    ]);
    expect((yield* h.launches.start(h.input(ticket.id))).status).toBe("launched");
  }).pipe(Effect.scoped),
);
it.effect("MCP defaults stay under the caller ceiling, and broader modes are refused", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const { ticket } = yield* h.create();
    yield* h.launches.start(h.input(ticket.id), {
      limits: { runtimeMode: "approval-required", interactionMode: "plan" },
    });
    expect(h.calls[0]?.runtimeMode).toBe("approval-required");
    const second = yield* h.create();
    expect(
      (yield* h.launches
        .start(
          { ...h.input(second.ticket.id, "second"), mode: "goal" },
          { limits: { runtimeMode: "full-access", interactionMode: "plan" } },
        )
        .pipe(Effect.flip))._tag,
    ).toBe("OrchestratorMcpFailure");
    expect(h.calls.length).toBe(1);
  }).pipe(Effect.scoped),
);
it.effect("another command cannot claim an existing thread, even when it is linked", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const { ticket } = yield* h.create();
    yield* h.launches.start(h.input(ticket.id));
    expect(
      (yield* h.launches
        .start({ ...h.input(ticket.id), commandId: CommandId.make("other-command") })
        .pipe(Effect.flip))._tag,
    ).toBe("TicketLaunchError");
    expect(h.calls.length).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("an active goal is active work even while the parent thread is idle", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const { ticket } = yield* h.create();
    yield* h.launches.start(h.input(ticket.id));
    const shell = h.shells.get(ThreadId.make("launch"))!;
    h.shells.set(shell.id, {
      ...shell,
      activeRunId: null,
      status: "idle",
      t3Goal: { status: "active" } as NonNullable<OrchestrationV2ThreadShell["t3Goal"]>,
    });
    expect((yield* h.launches.start(h.input(ticket.id, "second"))).status).toBe("already_active");
    h.shells.set(shell.id, {
      ...shell,
      activeRunId: null,
      status: "idle",
      t3Goal: { status: "blocked", needsInput: true } as NonNullable<
        OrchestrationV2ThreadShell["t3Goal"]
      >,
    });
    expect((yield* h.launches.start(h.input(ticket.id, "third"))).status).toBe("already_active");
    expect(h.calls.length).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect.each([
  { name: "a non-repository", repository: false, headCommit: false },
  { name: "a repository without HEAD", repository: true, headCommit: false },
])("worktree defaults launch $name at the project root", ({ repository, headCommit }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    h.setGit(repository, headCommit);
    const { ticket } = yield* h.create();
    yield* h.launches.start(h.input(ticket.id));
    expect(h.calls[0]?.workspaceStrategy).toEqual({ type: "root" });
  }).pipe(Effect.scoped),
);

it.effect(
  "launches with destination Brief references without injecting documents or host config",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const readme =
        "---\nid: fixture\narea: systems\n---\n" + "PRIVATE DOCUMENT BODY".repeat(10_000);
      yield* h.fs.writeFileString(h.path.join(h.home, "README.md"), readme);
      yield* h.fs.writeFileString(h.path.join(h.home, ".env"), "PRIVATE HOST CONFIG");
      const { ticket } = yield* h.create();
      yield* h.launches.start(h.input(ticket.id));
      const prompt = h.calls[0]!.initialMessage!.text;
      expect(prompt).toContain(`Ticket reference: ${ticket.readableId}`);
      expect(prompt).toContain(`Project Home: ${JSON.stringify(h.home)} (available at launch)`);
      expect(prompt).toContain(
        `README: ${JSON.stringify(h.path.join(h.home, "README.md"))} (readable at launch)`,
      );
      expect(prompt).toContain(
        `STATUS: ${JSON.stringify(h.path.join(h.home, "STATUS.md"))} (readable at launch)`,
      );
      expect(prompt).toContain(
        `Area context: ${JSON.stringify(h.path.join(h.home, "..", "AREA.md"))}`,
      );
      expect(prompt).toContain('Area bank "systems" and shared bank "shared"');
      expect(prompt).toContain("Memory capability is not verified at launch");
      expect(prompt).toContain("If absent or denied, record that context as unavailable");
      expect(prompt).toContain("plan mode remains plan mode");
      expect(prompt).not.toContain("PRIVATE");
      expect(prompt).not.toContain("Current project state.");
      expect(prompt.length).toBeLessThan(3000);
    }).pipe(Effect.scoped),
);

it.effect("non-Git and missing-Home launches report absent context without creating it", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    h.setGit(false);
    const empty = h.path.join(h.root, "non-git");
    yield* h.fs.makeDirectory(empty);
    h.setProject({ workspaceRoot: empty });
    const { ticket } = yield* h.create();
    yield* h.launches.start(h.input(ticket.id));
    const prompt = h.calls[0]!.initialMessage!.text;
    expect(h.calls[0]!.workspaceStrategy).toEqual({ type: "root" });
    expect(prompt).toContain(
      `README: ${JSON.stringify(h.path.join(empty, "README.md"))} (missing)`,
    );
    expect(prompt).toContain(
      `STATUS: ${JSON.stringify(h.path.join(empty, "STATUS.md"))} (missing)`,
    );
    expect(prompt).toContain("Area bank unresolved");
    expect(yield* h.fs.readDirectory(empty)).toEqual([]);

    const missing = h.path.join(h.root, "absent-home");
    h.setProject({ workspaceRoot: missing });
    const second = yield* h.create();
    yield* h.launches.start(h.input(second.ticket.id, "missing-home"));
    expect(h.calls[1]!.initialMessage!.text).toContain(
      `Project Home: ${JSON.stringify(missing)} (missing)`,
    );
    expect(yield* h.fs.exists(missing)).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect.each([
  { name: "missing metadata", readme: "# Project without frontmatter" },
  { name: "invalid bank", readme: "---\narea: systems/other\n---\n" },
  { name: "conflicting Area", readme: "---\narea: photography\n---\n" },
  {
    name: "metadata beyond the read bound",
    readme: "---\n" + "# padding\n".repeat(2000) + "area: systems\n---\n",
  },
])("does not invent an Area bank from $name", ({ readme }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* h.fs.writeFileString(h.path.join(h.home, "README.md"), readme);
    const { ticket } = yield* h.create();
    yield* h.launches.start(h.input(ticket.id));
    const prompt = h.calls[0]!.initialMessage!.text;
    expect(prompt).toContain("Area: unavailable");
    expect(prompt).toContain('Area bank unresolved; shared bank "shared"');
    expect(prompt).not.toContain('Area bank "systems"');
    expect(prompt).not.toContain('Area bank "photography"');
    expect(prompt).not.toContain("# padding");
  }).pipe(Effect.scoped),
);

it.effect(
  "unreadable and non-file context is explicit while the launch retains its permissions",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const home = h.path.join(h.root, "unreadable-context");
      yield* h.fs.makeDirectory(h.path.join(home, "STATUS.md"), { recursive: true });
      yield* h.fs.writeFileString(h.path.join(home, "README.md"), "---\narea: systems\n---\n");
      h.deniedReads.add(h.path.join(home, "README.md"));
      h.setProject({ workspaceRoot: home });
      const { ticket } = yield* h.create();
      yield* h.launches.start(h.input(ticket.id), {
        limits: { runtimeMode: "approval-required", interactionMode: "plan" },
      });
      const prompt = h.calls[0]!.initialMessage!.text;
      expect(prompt).toContain(
        `README: ${JSON.stringify(h.path.join(home, "README.md"))} (unavailable to read)`,
      );
      expect(prompt).toContain(
        `STATUS: ${JSON.stringify(h.path.join(home, "STATUS.md"))} (not a regular file)`,
      );
      expect(h.calls[0]!.runtimeMode).toBe("approval-required");
      expect(h.calls[0]!.interactionMode).toBe("plan");
    }).pipe(Effect.scoped),
);

it.effect("a synced Ticket uses the destination mapping and Home, including non-Git work", () =>
  Effect.gen(function* () {
    const source = yield* makeHarness;
    source.setProject({ id: ProjectId.make("source-project") });
    const { ticket } = yield* source.create();
    const destination = yield* makeHarness;
    destination.setProject({ id: ProjectId.make("destination-project") });
    destination.setGit(false);
    yield* destination.tickets.importEvents(
      (yield* source.tickets.timeline({ id: ticket.id })).events,
    );
    const result = yield* destination.launches.start({
      ...destination.input(ticket.id),
      projectId: ProjectId.make("destination-project"),
    });
    expect(result.projectId).toBe("destination-project");
    const prompt = destination.calls[0]!.initialMessage!.text;
    expect(prompt).toContain(destination.home);
    expect(prompt).not.toContain(source.home);
    expect(prompt).toContain('Area bank "systems"');
    expect(destination.calls[0]!.workspaceStrategy).toEqual({ type: "root" });
    expect((yield* destination.tickets.get(ticket.id)).ticket.projectKey).toBe(ticket.projectKey);
  }).pipe(Effect.scoped),
);

it.effect(
  "an accepted retry keeps the original Brief when files and the Ticket mapping change",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const { ticket } = yield* h.create();
      const input = h.input(ticket.id);
      yield* h.launches.start(input);
      const shell = h.shells.get(input.threadId)!;
      const first = h.calls[0]!;
      const runId = RunId.make("first-run");
      const messageId = MessageId.make("first-message");
      h.records.set(input.threadId, {
        ...idleThreadProjection(shell),
        runs: [
          {
            id: runId,
            threadId: shell.id,
            ordinal: 1,
            providerInstanceId: shell.providerInstanceId,
            modelSelection: shell.modelSelection,
            providerThreadId: null,
            userMessageId: messageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: shell.createdAt,
            startedAt: shell.createdAt,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            workspacePreparation: first.workspaceStrategy!,
          },
        ],
        messages: [
          {
            id: messageId,
            threadId: shell.id,
            runId,
            nodeId: null,
            role: "user",
            text: first.initialMessage!.text,
            attachments: [],
            streaming: false,
            createdAt: shell.createdAt,
            updatedAt: shell.createdAt,
            createdBy: "user",
            creationSource: "web",
          },
        ],
      });
      yield* h.fs.writeFileString(h.path.join(h.home, "README.md"), "# Changed after launch");
      yield* h.tickets.projectsMap({ key: ticket.projectKey!, projectId: null });
      yield* TestClock.adjust("1 hour");
      yield* h.launches.start(input);
      expect(h.calls[1]!.initialMessage).toEqual(first.initialMessage);
      expect(h.calls[1]!.workspaceStrategy).toEqual(first.workspaceStrategy);
      expect(h.calls[1]!.projectId).toBe(first.projectId);
      expect(h.shells.size).toBe(1);
      h.shells.set(input.threadId, { ...shell, activeRunId: null, status: "completed" });
      yield* h.launches.start({ ...h.input(ticket.id, "new-launch"), projectId: PROJECT });
      expect(h.calls[2]!.initialMessage!.text).not.toBe(first.initialMessage!.text);
      expect(h.calls[2]!.initialMessage!.text).toContain("Area bank unresolved");
    }).pipe(Effect.scoped),
);

it.effect.each(["missing", "unreadable", "without metadata"])(
  "keeps a declared Area reference while identifying %s adjacent Area context",
  (state) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const home = h.path.join(h.root, "unverified-area", "project");
      yield* h.fs.makeDirectory(home, { recursive: true });
      yield* h.fs.writeFileString(
        h.path.join(home, "README.md"),
        "---\nid: project\narea: systems\n---\n",
      );
      const areaFile = h.path.join(home, "..", "AREA.md");
      if (state !== "missing") yield* h.fs.writeFileString(areaFile, "# Area without metadata");
      if (state === "unreadable") h.deniedReads.add(areaFile);
      h.setProject({ workspaceRoot: home });
      const { ticket } = yield* h.create();
      yield* h.launches.start(h.input(ticket.id));
      const prompt = h.calls[0]!.initialMessage!.text;
      expect(prompt).toContain('Area bank "systems" and shared bank "shared"');
      const status =
        state === "missing"
          ? "missing"
          : state === "unreadable"
            ? "unavailable to read"
            : "readable at launch";
      expect(prompt).toContain(
        `Area context: ${JSON.stringify(areaFile)} (${status}; Area metadata unverified)`,
      );
    }).pipe(Effect.scoped),
);

it.effect("goal launches carry the Brief and preserve an accepted goal objective on retry", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const { ticket } = yield* h.create();
    const input = { ...h.input(ticket.id), mode: "goal" as const };
    yield* h.launches.start(input);
    expect(h.goals[0]).toMatchObject({
      objective: expect.stringContaining(`Project Home: ${JSON.stringify(h.home)}`),
    });
    const shell = h.shells.get(input.threadId)!;
    const command = h.goals[0]!;
    assert(command.type === "thread.goal.set");
    const projection = idleThreadProjection(shell);
    const applied = applyGoalCommand(
      projection.thread,
      {
        type: "set",
        commandId: command.commandId,
        objective: command.objective,
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        doneWhen: null,
        background: null,
        permissions: null,
        iterationTimeoutMins: undefined,
      },
      "2026-10-19T12:00:00.000Z",
    );
    assert(applied.ok && applied.goal);
    h.records.set(shell.id, {
      ...projection,
      thread: { ...projection.thread, goal: applied.goal },
    });
    const summary = goalSummary(applied.goal);
    expect(summary!.objective.length).toBeLessThan(command.objective.length);
    h.shells.set(shell.id, { ...shell, t3Goal: summary });
    yield* TestClock.adjust("1 hour");
    yield* h.launches.start(input);
    expect(h.goals[1]).toMatchObject({ objective: command.objective });
    expect(h.calls[1]!.initialMessage).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity", "custom-acp"])(
  "%s receives the same Brief without changing model selection or mode",
  (provider) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const { ticket } = yield* h.create();
      const modelSelection = {
        instanceId: ProviderInstanceId.make(provider),
        model: "fixture-model",
      };
      yield* h.launches.start({ ...h.input(ticket.id), modelSelection, mode: "default" });
      expect(h.calls[0]!.modelSelection).toEqual(modelSelection);
      expect(h.calls[0]!.interactionMode).toBe("default");
      expect(h.calls[0]!.initialMessage!.text).toContain(
        'Area bank "systems" and shared bank "shared"',
      );
      expect(h.calls[0]!.initialMessage!.text).toContain(
        "Memory capability is not verified at launch",
      );
    }).pipe(Effect.scoped),
);
