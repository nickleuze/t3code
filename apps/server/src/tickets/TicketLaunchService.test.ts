import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TicketId,
  type Project,
  type OrchestrationV2ThreadShell,
  type TicketStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launches from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Defaults from "../project/ProjectLaunchDefaults.ts";
import * as Tickets from "./TicketService.ts";
import * as Start from "./TicketLaunchService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
const PROJECT = ProjectId.make("project:mcp-test");
const makeHarness = Effect.gen(function* () {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const calls: Launches.ThreadLaunchInput[] = [];
  const goals: unknown[] = [];
  const template = liveThreadShell(ThreadId.make("template"));
  const project = {
    id: PROJECT,
    title: "Fixture",
    defaultModelSelection: template.modelSelection,
    defaultThreadEnvMode: null,
  } as Project;
  let ticketService: Tickets.TicketService["Service"];
  let failure: "reject" | "ambiguous" | undefined;
  let envMode = "worktree";
  const dependencies = Layer.mergeAll(
    Layer.mock(Receipts.CommandReceiptStoreV2)({
      getByCommandId: (commandId) =>
        Effect.succeedSome({
          commandId,
          threadId: ThreadId.make(commandId),
          commandType: "thread.create",
          status: "accepted",
        } as Receipts.CommandReceiptV2),
    }),
    NodeCrypto.layer,
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeedSome({
          projectId: PROJECT,
          title: "Fixture",
          workspaceRoot: "/tmp/ticket-fixture",
          deletedAt: null,
        } as ProjectStore.ProjectRow),
      list: () => Effect.succeed([]),
    }),
    Layer.mock(Projects.ProjectService)({ getById: () => Effect.succeedSome(project) }),
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
      getThreadRecords: (id) => Effect.succeed(idleThreadProjection(shells.get(id)!)),
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
    Effect.provideContext(context),
  );
  const create = (assigned = true) =>
    tickets.upsert({ title: "Launch fixture", ...(assigned ? { projectId: PROJECT } : {}) });
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
    setFailure: (value: typeof failure) => {
      failure = value;
    },
    setEnvMode: (value: string) => {
      envMode = value;
    },
  };
});

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
