import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Tickets from "./TicketService.ts";
import * as Observations from "./TicketObservations.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";

it.effect.each([
  { role: "work", status: "inbox", model: "fixture", expected: "in_progress" },
  { role: "work", status: "ready", model: undefined, expected: "in_progress" },
  { role: "planning", status: "inbox", model: "fixture", expected: "inbox" },
] as const)("a $role run from $status records agent attribution once", (test) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Tickets.layer.pipe(
        Layer.provide(Projects.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Sqlite.layerMemory),
      ),
    );
    const tickets = yield* Tickets.TicketService.pipe(Effect.provideContext(context));
    const { ticket } = yield* tickets.upsert({ title: "Run attribution", status: test.status });
    const threadId = ThreadId.make("work-run");
    yield* tickets.link({ id: ticket.id, threadId, role: test.role });
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, test.status);
    const worker = yield* Observations.make.pipe(
      Effect.provideContext(context),
      Effect.provide(Layer.mock(Sink.EventSinkV2)({})),
    );
    const run = {
      sequence: 1,
      commandId: CommandId.make("run"),
      event: {
        type: "run.created",
        payload: {
          threadId,
          ...(test.model ? { modelSelection: { model: test.model } } : {}),
        },
      },
    } as unknown as OrchestrationV2StoredEvent;
    yield* worker.observe(run);
    yield* worker.drain;
    yield* worker.observe({ ...run, sequence: 2 });
    yield* worker.drain;
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, test.expected);
    const events = (yield* tickets.timeline({ id: ticket.id })).events;
    const by = tickets.author({
      actor: "agent",
      thread: threadId,
      ...(test.model ? { model: test.model } : {}),
    });
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "stage" && event.reason === "start_work")
        .map((event) => event.by),
      test.role === "work" ? [by] : [],
    );
    assert.deepStrictEqual(
      events
        .filter((event) => event.type === "auto")
        .filter((event) => event.kind === "thread_started")
        .map((event) => ({ by: event.by, ref: event.ref })),
      [{ by, ref: threadId }],
    );
  }),
);

it.effect(
  "observations start after the current sequence, ignore reconciliation and consume PR link/merge snapshots",
  () =>
    Effect.gen(function* () {
      const observed: Tickets.TicketObservation[] = [];
      let after: number | undefined;
      const dependencies = Layer.mergeAll(
        Layer.mock(Sink.EventSinkV2)({
          latestSequence: () => Effect.succeed(42),
          stream: (input) => {
            after = input?.afterSequence;
            return Stream.empty;
          },
        }),
        Layer.mock(Tickets.TicketService)({
          ticketsLinkedToThread: () => Effect.succeed([]),
          ticketsLinkedToReference: () => Effect.succeed([]),
          author: () => ({ actor: "user", machine: "A" }),
          observe: (input) =>
            Effect.sync(() => {
              observed.push(input);
            }),
        }),
      );
      const worker = yield* Observations.make.pipe(Effect.provide(dependencies));
      yield* worker.start;
      yield* Effect.yieldNow;
      assert.equal(after, 42);
      const event = (state: string, isDraft = false, commandId = "live") =>
        ({
          sequence: 43,
          commandId: CommandId.make(commandId),
          event: {
            type: "thread.pull-request-synced",
            payload: {
              id: ThreadId.make("work"),
              pullRequests: [
                {
                  number: 7,
                  url: "https://fixture.local/pull/7",
                  source: "manual",
                  snapshot: { state, isDraft, title: "Implementation" },
                },
              ],
            },
          },
        }) as unknown as OrchestrationV2StoredEvent;
      yield* worker.observe(event("open", false, "command:runtime-reconcile:test"));
      yield* worker.observe(event("open", true));
      yield* worker.drain;
      assert.equal(observed.length, 0);
      yield* worker.observe(event("open"));
      yield* worker.drain;
      assert.equal(observed[0]?.kind, "pr_linked");
      yield* worker.observe(event("merged"));
      yield* worker.drain;
      assert.deepStrictEqual(
        observed.map((o) => o.kind),
        ["pr_linked", "pr_linked", "pr_merged"],
      );
      assert.equal(observed[2]?.key, "pr-merged:https://fixture.local/pull/7");
      yield* worker.observe(event("closed", true));
      yield* worker.drain;
      assert.equal(observed.at(-1)?.kind, "pr_closed");
    }),
);
it.effect("supporting and main PR merges leave a two-PR ticket in review until acceptance", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Tickets.layer.pipe(
        Layer.provide(Projects.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Sqlite.layerMemory),
      ),
    );
    const tickets = yield* Tickets.TicketService.pipe(Effect.provideContext(context));
    const { ticket } = yield* tickets.upsert({ title: "Two-PR finish condition" });
    const threadId = ThreadId.make("two-pr-work");
    yield* tickets.link({ id: ticket.id, threadId, role: "work", startWork: true });
    const worker = yield* Observations.make.pipe(
      Effect.provideContext(context),
      Effect.provide(Layer.mock(Sink.EventSinkV2)({})),
    );
    const snapshot = (main: "open" | "merged", supporting: "open" | "merged") =>
      worker.observe({
        sequence: 1,
        commandId: CommandId.make("live-pr-sync"),
        event: {
          type: "thread.pull-request-synced",
          payload: {
            id: threadId,
            title: "Implementation and CI",
            pullRequests: [main, supporting].map((state, index) => ({
              number: index + 19,
              url: `https://fixture.local/pull/${index + 19}`,
              source: "manual",
              snapshot: { state, isDraft: false, title: index === 0 ? "Main" : "CI" },
            })),
          },
        },
      } as unknown as OrchestrationV2StoredEvent);

    yield* snapshot("open", "open");
    yield* worker.drain;
    yield* snapshot("open", "merged");
    yield* worker.drain;
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, "in_review");
    assert.deepStrictEqual((yield* tickets.get(ticket.id)).ticket.workState?.prs, [
      "https://fixture.local/pull/19",
      "https://fixture.local/pull/20",
    ]);
    const afterSupporting = (yield* tickets.timeline({ id: ticket.id })).events;
    assert.deepStrictEqual(
      afterSupporting.flatMap((e) => (e.type === "auto" && e.kind === "pr_merged" ? [e.ref] : [])),
      ["https://fixture.local/pull/20"],
    );
    yield* snapshot("open", "merged");
    yield* worker.drain;
    assert.deepStrictEqual((yield* tickets.timeline({ id: ticket.id })).events, afterSupporting);
    yield* snapshot("merged", "merged");
    yield* worker.drain;
    assert.equal((yield* tickets.get(ticket.id)).ticket.status, "in_review");

    yield* tickets.entry({ id: ticket.id, kind: "result", text: "Finish condition verified" });
    yield* tickets.action({ id: ticket.id, action: "accept" });
    const accepted = yield* tickets.get(ticket.id);
    assert.equal(accepted.ticket.status, "done");
    yield* tickets.observe({ threadId, key: "late-link", kind: "pr_linked", ref: "late-pr" });
    yield* tickets.observe({ threadId, key: "late-merge", kind: "pr_merged", ref: "late-pr" });
    yield* tickets.observe({ threadId, key: "child-result", kind: "task_done", ref: "child" });
    yield* tickets.entry({ id: ticket.id, kind: "result", text: "Later child verification" });
    yield* snapshot("merged", "merged");
    yield* worker.drain;
    yield* tickets.rebuild;
    const after = yield* tickets.get(ticket.id);
    assert.equal(after.ticket.status, "done");
    assert.equal(after.ticket.statusSetAt, accepted.ticket.statusSetAt);
    assert.isFalse(after.ticket.workState?.resultReady);
    assert.deepStrictEqual(
      (yield* tickets.timeline({ id: ticket.id })).events.flatMap((e) =>
        e.type === "stage" && e.stage === "done" ? [e.reason] : [],
      ),
      ["accepted"],
    );
  }),
);

it.effect("an unrelated metadata update never replays a preexisting goal or its iterations", () =>
  Effect.gen(function* () {
    const observed: Tickets.TicketObservation[] = [];
    const thread = {
      id: ThreadId.make("goal-owner"),
      title: "Goal",
      goal: {
        id: "existing",
        objective: "Work",
        status: "complete",
        iteration: 1,
        createdAt: "old",
        updatedAt: "new",
        history: [{ iteration: 1 }],
      },
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(Sink.EventSinkV2)({
        latestSequence: () => Effect.succeed(42),
        stream: () => Stream.empty,
      }),
      Layer.mock(Projection.ProjectionStoreV2)({
        getGoalThreads: () =>
          Effect.succeed([
            thread as unknown as import("@t3tools/contracts").OrchestrationV2AppThread,
          ]),
      }),
      Layer.mock(Tickets.TicketService)({
        ticketsLinkedToThread: () => Effect.succeed([]),
        ticketsLinkedToReference: () => Effect.succeed([]),
        author: () => ({ actor: "user", machine: "A" }),
        observe: (input) =>
          Effect.sync(() => {
            observed.push(input);
          }),
      }),
    );
    const worker = yield* Observations.make.pipe(Effect.provide(dependencies));
    yield* worker.start;
    yield* worker.observe({
      sequence: 43,
      commandId: CommandId.make("metadata"),
      event: { type: "thread.metadata-updated", payload: thread },
    } as unknown as OrchestrationV2StoredEvent);
    yield* worker.drain;
    assert.equal(observed.length, 0);
  }),
);

it.effect(
  "a witnessed goal start links and starts work; goal iteration, task completion and input/settle only record activity",
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Tickets.layer.pipe(
          Layer.provide(Projects.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(Sqlite.layerMemory),
        ),
      );
      const tickets = yield* Tickets.TicketService.pipe(Effect.provideContext(context));
      const { ticket } = yield* tickets.upsert({ title: "Goal and task seam" });
      const threadId = ThreadId.make("owner");
      yield* tickets.link({ id: ticket.id, threadId, role: "work", title: "Owner" });
      const worker = yield* Observations.make.pipe(
        Effect.provideContext(context),
        Effect.provide(
          Layer.mock(Sink.EventSinkV2)({
            latestSequence: () => Effect.succeed(0),
            stream: () => Stream.empty,
          }),
        ),
      );
      const goal = {
        id: "goal-1",
        objective: "Implement",
        status: "active",
        iteration: 0,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        history: [] as { iteration: number }[],
      };
      const thread = { id: threadId, title: "Owner", modelSelection: { model: "fixture" }, goal };
      const observe = (type: string, payload: object) =>
        worker.observe({
          sequence: 1,
          commandId: CommandId.make("live"),
          event: { type, threadId, payload },
        } as unknown as OrchestrationV2StoredEvent);
      yield* observe("thread.metadata-updated", thread);
      yield* worker.drain;
      assert.equal((yield* tickets.get(ticket.id)).ticket.status, "in_progress");
      assert.equal(
        (yield* tickets.get(ticket.id)).references.find((l) => l.kind === "goal")?.title,
        "Implement",
      );
      yield* observe("thread.metadata-updated", {
        ...thread,
        goal: {
          ...goal,
          objective: "Implement improved",
          iteration: 1,
          history: [{ iteration: 1 }],
        },
      });
      const task = {
        id: "task-1",
        threadId,
        origin: "app_owned",
        status: "running",
        title: "Delegate",
        prompt: "Work",
        model: "fixture",
      };
      yield* observe("subagent.updated", task);
      yield* worker.drain;
      yield* observe("subagent.updated", { ...task, title: "Delegate final", status: "completed" });
      yield* observe("runtime-request.updated", { id: "request-1", status: "pending" });
      yield* observe("thread.settled", thread);
      yield* worker.drain;
      const state = yield* tickets.get(ticket.id);
      assert.equal(state.ticket.status, "in_progress");
      assert.equal(state.references.find((l) => l.kind === "task")?.title, "Delegate final");
      const trail = (yield* tickets.timeline({ id: ticket.id })).events
        .filter((e) => e.type === "auto")
        .map((e) => e.kind);
      for (const kind of ["goal_iteration_done", "task_done", "needs_input", "thread_settled"])
        assert.include(trail, kind);
    }),
);

it.effect("unlinked metadata costs one lookup and no ticket state or history reads", () =>
  Effect.gen(function* () {
    let lookups = 0;
    let reads = 0;
    const dependencies = Layer.mergeAll(
      Layer.mock(Sink.EventSinkV2)({}),
      Layer.mock(Tickets.TicketService)({
        author: () => ({ actor: "user", machine: "A" }),
        ticketsLinkedToThread: () =>
          Effect.sync(() => {
            lookups++;
            return [];
          }),
        list: () =>
          Effect.sync(() => {
            reads++;
            return { tickets: [] };
          }),
        get: () =>
          Effect.sync(() => {
            reads++;
            throw new Error("Unexpected state read");
          }),
        timeline: () =>
          Effect.sync(() => {
            reads++;
            return { events: [], machines: {} };
          }),
      }),
    );
    const worker = yield* Observations.make.pipe(Effect.provide(dependencies));
    yield* worker.observe({
      sequence: 1,
      commandId: CommandId.make("metadata"),
      event: {
        type: "thread.metadata-updated",
        payload: { id: ThreadId.make("unlinked"), title: "Pinned" },
      },
    } as unknown as OrchestrationV2StoredEvent);
    yield* worker.drain;
    assert.equal(lookups, 1);
    assert.equal(reads, 0);
  }),
);
