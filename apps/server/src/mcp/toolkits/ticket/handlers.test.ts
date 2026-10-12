import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type TicketUpsertInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as Projects from "../../../orchestration-v2/ProjectStore.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Launches from "../../../tickets/TicketLaunchService.ts";
import * as Tickets from "../../../tickets/TicketService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { TicketToolkit } from "./tools.ts";

const CALLER = ThreadId.make("thread:caller");
const WORK = ThreadId.make("thread:work");
const OTHER_PROJECT = ProjectId.make("project:other");
const callerShell = liveThreadShell(CALLER);
const PROJECT = callerShell.projectId;
const EPOCH = "1970-01-01T00:00:00.000Z";
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:tickets"),
  requestNamespace: "provider:ticket-tests",
  thread: {
    threadId: CALLER,
    providerSessionId: "provider:ticket-tests",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const outside: Partial<McpInvocationContext.McpInvocationScope> = {
  thread: undefined,
  client: { sessionId: "outside", label: "Outside", access: "full-access" },
};
const readOnly = {
  ...outside,
  client: { sessionId: "reader", label: "Reader", access: "read-only" },
} satisfies Partial<McpInvocationContext.McpInvocationScope>;

const project = (id: ProjectId): Projects.ProjectRow => ({
  projectId: id,
  title: id === PROJECT ? "Main project" : "Other project",
  workspaceRoot: "/tmp/ticket-test",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: EPOCH,
  updatedAt: EPOCH,
  deletedAt: null,
});

const makeHarness = Effect.fn("makeTicketToolkitHarness")(function* (
  caller = callerShell,
  work = liveThreadShell(WORK),
) {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [CALLER, caller],
    [WORK, work],
  ]);
  const starts: import("@t3tools/contracts").TicketStartInput[] = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(Launches.TicketLaunchService)({
      start: (input) =>
        Effect.sync(() => {
          starts.push(input);
          return {
            status: "launched" as const,
            threadId: input.threadId,
            projectId: PROJECT,
            modelSelection: caller.modelSelection,
            interactionMode:
              input.mode === undefined || input.mode === "plan"
                ? ("plan" as const)
                : ("default" as const),
          };
        }),
    }),
    Layer.mock(Projects.ProjectStoreV2)({
      get: (id) => Effect.succeedSome(project(id)),
      list: (input) => Effect.succeed((input?.projectIds ?? [PROJECT, OTHER_PROJECT]).map(project)),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.sync(() => shells.get(id) ?? null),
    }),
    NodeCrypto.layer,
  );
  const services = Tickets.layer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provide(Sqlite.layerMemory),
  );
  const context = yield* Layer.build(services);
  const tickets = yield* Tickets.TicketService.pipe(Effect.provideContext(context));
  const server = yield* McpServer.McpServer.pipe(
    Effect.provide(
      McpHttpServer.layerTicketToolkit.pipe(Layer.provideMerge(McpServer.McpServer.layer)),
    ),
    Effect.provideContext(context),
  );
  const client = McpSchema.McpServerClient.of({
    clientId: 1,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
    clientInfo: { name: "ticket-test", version: "1" },
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ticket-test", version: "1" },
    },
    getClient: Effect.die("unused"),
  });
  const call = (
    name: keyof typeof TicketToolkit.tools,
    args: Record<string, unknown>,
    overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
  ) =>
    server.callTool({ name, arguments: args }).pipe(
      Effect.map(
        (result) =>
          result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text),
      ),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provideService(McpInvocationContext.McpInvocationContext, { ...scope, ...overrides }),
    );
  const seed = (input: TicketUpsertInput) =>
    tickets.upsert({ projectId: PROJECT, ...input }).pipe(Effect.map(({ ticket }) => ticket));
  return { call, tickets, shells, seed, starts };
});

it.effect("work records list a null legacy issue field", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.seed({ title: "Work record" });
    const result = yield* harness.call("t3_ticket_list", {});
    expect(result.tickets[0].githubIssue).toBeNull();
  }),
);

describe("ticket toolkit handlers", () => {
  it.effect("creates agent tickets with the caller's project and an origin-only link", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("t3_ticket_create", { title: "  Follow up  " });
      expect(result).toMatchObject({
        title: "Follow up",
        status: "inbox",
        project: { id: PROJECT, title: "Main project" },
      });
      const [ticket] = (yield* harness.tickets.list()).tickets;
      expect(ticket).toMatchObject({
        id: result.id,
        createdBy: "agent",
        creationSource: "mcp",
        originThreadId: CALLER,
        body: "",
        links: [{ threadId: CALLER, role: "origin" }],
      });
      harness.shells.set(CALLER, {
        ...callerShell,
        latestRunStartedAt: DateTime.makeUnsafe("1970-01-01T00:00:10.000Z"),
      });
      expect((yield* harness.call("t3_ticket_list", {})).tickets[0].status).toBe("inbox");
    }),
  );

  it.effect("creates without a caller and respects explicit projects and status", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call("t3_ticket_create", { title: "Outside" }, outside)).toMatchObject({
        title: "Outside",
        status: "inbox",
        project: null,
      });
      expect(
        yield* harness.call("t3_ticket_create", {
          title: "Different project",
          body: "Details",
          projectId: OTHER_PROJECT,
          status: "ready",
        }),
      ).toMatchObject({ status: "ready", project: { id: OTHER_PROJECT } });
      yield* harness.call("t3_ticket_create", { title: "Unassigned", projectId: null });
      const tickets = (yield* harness.tickets.list()).tickets;
      expect(tickets.find((ticket) => ticket.title === "Outside")).toMatchObject({
        originThreadId: null,
        links: [],
      });
      expect(tickets.find((ticket) => ticket.title === "Unassigned")?.projectId).toBeNull();
    }),
  );

  it.effect("deduplicates caller-scoped creation retries without overwriting later edits", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const input = { title: "Once", clientRequestId: "create:1" };
      const first = yield* harness.call("t3_ticket_create", input);
      yield* harness.call("t3_ticket_update", { id: first.id, title: "Edited later" });
      yield* harness.call("t3_ticket_link_thread", { id: first.id });
      const retry = yield* harness.call("t3_ticket_create", input);
      expect(retry).toEqual(first);
      expect((yield* harness.tickets.list()).tickets).toMatchObject([
        { title: "Edited later", links: [{ threadId: CALLER, role: "work" }] },
      ]);
      yield* harness.call("t3_ticket_link_thread", { id: first.id, unlink: true });
      yield* harness.call("t3_ticket_create", input);
      expect((yield* harness.tickets.list()).tickets[0]?.links).toEqual([]);
      const other = yield* harness.call("t3_ticket_create", input, { requestNamespace: "other" });
      expect(other.id).not.toBe(first.id);
      expect((yield* harness.tickets.list()).tickets).toHaveLength(2);
    }),
  );

  it.effect("filters projects, query and explicit stage and returns bounded work summaries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const ticket = yield* harness.seed({
        title: "Improve parser",
        body: " Need   validation ".repeat(100),
      });
      yield* harness.tickets.link({ id: ticket.id, threadId: WORK, role: "work" });
      harness.shells.set(WORK, {
        ...liveThreadShell(WORK),
        title: "Parser work",
        latestRunStartedAt: DateTime.makeUnsafe("1970-01-01T00:00:10.000Z"),
      });
      yield* harness.seed({ title: "Other", projectId: OTHER_PROJECT });
      yield* harness.seed({ title: "Unassigned", projectId: null });
      yield* harness.seed({ title: "Done", status: "done" });
      yield* harness.seed({ title: "Dropped", status: "dropped" });
      const deleted = yield* harness.seed({ title: "Deleted" });
      yield* harness.tickets.delete({ id: deleted.id });

      yield* harness.tickets.upsert({ id: ticket.id, status: "in_progress" });
      const result = yield* harness.call("t3_ticket_list", {
        query: "VALIDATION",
        status: "in_progress",
      });
      expect(result).toEqual({
        tickets: [
          {
            id: ticket.id,
            title: "Improve parser",
            status: "in_progress",
            project: { id: PROJECT, title: "Main project" },
            bodyExcerpt: expect.stringMatching(/…$/),
            githubIssue: null,
            workThreads: [{ id: WORK, title: "Parser work", status: "running" }],
            workThreadsOmitted: 0,
          },
        ],
        hasMore: false,
      });
      expect(result.tickets[0].bodyExcerpt.length).toBe(160);
      expect((yield* harness.call("t3_ticket_list", {})).tickets).toHaveLength(1);
      expect((yield* harness.call("t3_ticket_list", { status: "inbox" })).tickets).toEqual([]);
      expect((yield* harness.call("t3_ticket_list", { projectId: "all" })).tickets).toHaveLength(3);
      expect((yield* harness.call("t3_ticket_list", { includeDone: true })).tickets).toHaveLength(
        3,
      );
      expect((yield* harness.call("t3_ticket_list", { status: "done" })).tickets).toMatchObject([
        { title: "Done" },
      ]);
      expect(
        (yield* harness.call("t3_ticket_list", { projectId: OTHER_PROJECT })).tickets,
      ).toMatchObject([{ title: "Other" }]);
      expect((yield* harness.call("t3_ticket_list", {}, outside)).tickets).toHaveLength(3);
      expect(
        (yield* harness.call("t3_ticket_list", { projectId: null }, outside)).tickets,
      ).toMatchObject([{ title: "Unassigned" }]);
      expect(
        yield* harness.call("t3_ticket_list", { projectId: "all", limit: 1 }, readOnly),
      ).toMatchObject({
        tickets: [expect.any(Object)],
        hasMore: true,
      });

      const at = "1970-01-01T00:00:15.000Z";
      const work = harness.shells.get(WORK)!;
      harness.shells.set(WORK, {
        ...work,
        pullRequests: [
          {
            host: "github.com",
            repository: "nick/repo",
            number: 1,
            url: "https://github.com/nick/repo/pull/1",
            source: "agent",
            linkedAt: at,
            snapshot: null,
            stack: null,
          },
        ],
      });
      expect((yield* harness.call("t3_ticket_list", { status: "in_review" })).tickets).toEqual([]);
      expect((yield* harness.call("t3_ticket_get", { ticket: ticket.id })).ticket.status).toBe(
        "in_progress",
      );
      yield* TestClock.adjust("20 seconds");
      expect(
        yield* harness.call("t3_ticket_update", { id: ticket.id, status: "ready" }),
      ).toMatchObject({ status: "ready" });
      expect((yield* harness.call("t3_ticket_list", { status: "in_review" })).tickets).toEqual([]);
    }),
  );

  it.effect("defaults to 50 rows, caps linked work output and retains missing thread IDs", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const ticket = yield* harness.seed({ title: "Many links" });
      for (let index = 0; index < 12; index++) {
        yield* harness.tickets.link({
          id: ticket.id,
          threadId: ThreadId.make(`missing:${index}`),
          role: "work",
        });
      }
      const [row] = (yield* harness.call("t3_ticket_list", {})).tickets;
      expect(row.workThreads).toHaveLength(10);
      expect(row.workThreadsOmitted).toBe(2);
      expect(row.workThreads[0]).toMatchObject({ title: null, status: null });
      for (let index = 0; index < 50; index++) yield* harness.seed({ title: `Ticket ${index}` });
      const result = yield* harness.call("t3_ticket_list", {});
      expect(result.tickets).toHaveLength(50);
      expect(result.hasMore).toBe(true);
    }),
  );

  it.effect(
    "patches only supplied fields, allows clearing and refuses nonexistent/deleted tickets",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const ticket = yield* harness.seed({ title: "Original", body: "Keep", status: "ready" });
        yield* harness.call("t3_ticket_update", { id: ticket.id, title: "New" });
        expect((yield* harness.tickets.list()).tickets[0]).toMatchObject({
          title: "New",
          body: "Keep",
          status: "ready",
          statusSetAt: ticket.statusSetAt,
          projectId: PROJECT,
        });
        yield* harness.call("t3_ticket_update", { id: ticket.id, body: "", projectId: null });
        expect((yield* harness.tickets.list()).tickets[0]).toMatchObject({
          body: "",
          projectId: null,
        });
        expect(
          yield* harness.call("t3_ticket_update", { id: "missing", title: "No" }),
        ).toMatchObject({ code: "invalid_request" });
        yield* harness.tickets.delete({ id: ticket.id });
        expect(
          yield* harness.call("t3_ticket_update", { id: ticket.id, title: "No" }),
        ).toMatchObject({ code: "invalid_request" });
        expect((yield* harness.tickets.list({ includeDeleted: true })).tickets).toHaveLength(1);
      }),
  );

  it.effect(
    "links and unlinks with caller/work defaults, including cleanup of missing threads",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const ticket = yield* harness.seed({ title: "Work" });
        yield* harness.call("t3_ticket_link_thread", { id: ticket.id });
        expect((yield* harness.tickets.list()).tickets[0]?.links).toMatchObject([
          { threadId: CALLER, role: "work" },
        ]);
        yield* harness.call("t3_ticket_link_thread", {
          id: ticket.id,
          threadId: WORK,
          role: "origin",
        });
        yield* harness.call("t3_ticket_link_thread", { id: ticket.id, unlink: true });
        expect((yield* harness.tickets.list()).tickets[0]?.links).toMatchObject([
          { threadId: WORK, role: "origin" },
        ]);
        expect(
          yield* harness.call("t3_ticket_link_thread", { id: ticket.id }, outside),
        ).toMatchObject({ code: "target_required" });
        expect(
          yield* harness.call("t3_ticket_link_thread", { id: ticket.id, threadId: "missing" }),
        ).toMatchObject({ code: "thread_not_found" });
        harness.shells.delete(WORK);
        yield* harness.call("t3_ticket_link_thread", {
          id: ticket.id,
          threadId: WORK,
          unlink: true,
        });
        expect((yield* harness.tickets.list()).tickets[0]?.links).toEqual([]);
      }),
  );

  it.effect("enforces writesThreads target modes for both link and unlink", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ...callerShell,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      const ticket = yield* harness.seed({ title: "Restricted" });
      for (const unlink of [false, true]) {
        expect(
          yield* harness.call("t3_ticket_link_thread", { id: ticket.id, threadId: WORK, unlink }),
        ).toMatchObject({ code: "runtime_mode_escalation_denied" });
      }
      harness.shells.set(WORK, { ...liveThreadShell(WORK), runtimeMode: "approval-required" });
      expect(
        yield* harness.call("t3_ticket_link_thread", { id: ticket.id, threadId: WORK }),
      ).toMatchObject({ code: "interaction_mode_escalation_denied" });
      harness.shells.set(WORK, {
        ...liveThreadShell(WORK),
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      expect(
        yield* harness.call("t3_ticket_link_thread", { id: ticket.id, threadId: WORK }),
      ).toMatchObject({ id: ticket.id });
      expect(yield* harness.call("t3_ticket_link_thread", { id: ticket.id })).toMatchObject({
        id: ticket.id,
      });
    }),
  );

  it.effect(
    "gates every tool with orchestration and refuses read-only clients and ended writers",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const ticket = yield* harness.seed({ title: "Protected" });
        const calls = [
          ["t3_ticket_create", { title: "No" }],
          ["t3_ticket_update", { id: ticket.id, title: "No" }],
          ["t3_ticket_link_thread", { id: ticket.id, threadId: WORK }],
        ] as const;
        for (const [name, args] of calls) {
          expect(yield* harness.call(name, args, readOnly)).toMatchObject({
            code: "capability_denied",
          });
          expect(yield* harness.call(name, args, { capabilities: new Set() })).toMatchObject({
            code: "capability_denied",
          });
        }
        expect(
          yield* harness.call("t3_ticket_list", {}, { capabilities: new Set() }),
        ).toMatchObject({ code: "capability_denied" });
        harness.shells.set(CALLER, { ...callerShell, activeRunId: null });
        for (const [name, args] of calls)
          expect(yield* harness.call(name, args)).toMatchObject({ code: "parent_not_active" });
        expect((yield* harness.call("t3_ticket_list", {})).tickets).toHaveLength(1);
        expect((yield* harness.tickets.list()).tickets[0]).toMatchObject({
          title: "Protected",
          links: [],
        });
      }),
  );
});

it.effect(
  "MCP entry dedupe survives a lost response and signs the caller model/thread/machine",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const ticket = yield* harness.seed({ title: "Milestones" });
      const input = {
        ticket: ticket.id,
        kind: "handoff",
        text: "Built",
        next: "Review",
        clientRequestId: "retry",
      };
      yield* harness.call("t3_ticket_entry", input);
      yield* TestClock.adjust("1 second");
      yield* harness.call("t3_ticket_entry", input);
      const state = yield* harness.call("t3_ticket_get", { ticket: ticket.id });
      const entries = state.timeline.filter((event: { type: string }) => event.type === "entry");
      expect(entries).toHaveLength(1);
      expect(entries[0].by).toEqual({
        actor: "agent",
        thread: CALLER,
        model: callerShell.modelSelection.model,
        machine: "test",
      });
      expect(state.ticket.workState.lastHandoff).toMatchObject({ text: "Built", next: "Review" });
      const denied = yield* harness.call(
        "t3_ticket_entry",
        { ...input, clientRequestId: "denied" },
        readOnly,
      );
      expect(denied).toMatchObject({ code: "capability_denied" });
    }),
);

it.effect("ticket start defaults to plan and caller-scoped retry ids", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const ticket = yield* h.seed({ title: "Start" });
    const result = yield* h.call("t3_ticket_start", {
      ticket: ticket.id,
      clientRequestId: "stable",
    });
    yield* h.call("t3_ticket_start", { ticket: ticket.id, clientRequestId: "stable" });
    expect(result.interactionMode).toBe("plan");
    expect(result.threadUrl).toBe(`t3-thread://v1/${result.threadId}`);
    expect(h.starts[0]?.commandId).toBe(h.starts[1]?.commandId);
    expect(h.starts[0]?.threadId).toBe(h.starts[1]?.threadId);
    yield* h.call(
      "t3_ticket_start",
      { ticket: ticket.id, clientRequestId: "stable" },
      { ...outside, requestNamespace: "other-client" },
    );
    expect(h.starts[2]?.threadId).not.toBe(h.starts[0]?.threadId);
  }),
);
it.effect("ticket start refuses mode escalation and read-only callers before launching", () =>
  Effect.gen(function* () {
    const caller = {
      ...callerShell,
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    };
    const h = yield* makeHarness(caller);
    const ticket = yield* h.seed({ title: "Limits" });
    expect(yield* h.call("t3_ticket_start", { ticket: ticket.id, mode: "default" })).toMatchObject({
      code: "interaction_mode_escalation_denied",
    });
    expect(yield* h.call("t3_ticket_start", { ticket: ticket.id, mode: "goal" })).toMatchObject({
      code: "interaction_mode_escalation_denied",
    });
    expect(
      yield* h.call("t3_ticket_start", { ticket: ticket.id, runtimeMode: "full-access" }),
    ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(yield* h.call("t3_ticket_start", { ticket: ticket.id }, readOnly)).toMatchObject({
      code: "capability_denied",
    });
    expect(h.starts).toEqual([]);
  }),
);
