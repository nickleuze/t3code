import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  TicketId,
  WS_METHODS,
  type Ticket,
  type TicketListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createTicketEnvironmentAtoms, ticketIdsByThread } from "./tickets.ts";

const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);
const env = EnvironmentId.make("tickets-host");
const ticket: Ticket = {
  id: TicketId.make("ticket:one"),
  title: "Title",
  body: "",
  projectId: null,
  status: "ready",
  statusSetAt: "2026-10-11T00:00:00.000Z",
  sortKey: 0,
  createdBy: "user",
  creationSource: "web",
  originThreadId: null,
  githubIssue: null,
  links: [],
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
  deletedAt: null,
};
const harness = Effect.fnUntraced(function* (supports?: boolean, ticketGithub?: boolean) {
  const sent: { tag: string; input: unknown }[] = [];
  const snapshots = yield* Queue.unbounded<TicketListResult>();
  const client = Object.fromEntries([
    ...[
      WS_METHODS.ticketsUpsert,
      WS_METHODS.ticketsDelete,
      WS_METHODS.ticketsRestore,
      WS_METHODS.ticketsLink,
      WS_METHODS.ticketsUnlink,
    ].map((tag) => [
      tag,
      (input: unknown) =>
        Effect.sync(() => {
          sent.push({ tag, input });
          return tag === WS_METHODS.ticketsDelete ? { id: ticket.id } : { ticket };
        }),
    ]),
    [
      WS_METHODS.ticketsSubscribe,
      () => {
        sent.push({ tag: WS_METHODS.ticketsSubscribe, input: {} });
        return Stream.fromQueue(snapshots);
      },
    ],
  ]);
  const supervisor = {
    target: { environmentId: env },
    session: yield* SubscriptionRef.make(
      Option.some({
        initialConfig: Effect.succeed({
          environment: {
            environmentId: env,
            capabilities:
              supports === undefined
                ? {}
                : { tickets: supports, ...(ticketGithub === undefined ? {} : { ticketGithub }) },
          },
        }),
        client,
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry["Service"]),
  );
  const atoms = createTicketEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { atoms, registry, sent, snapshots };
});

it.effect("gates every command on tickets support before dispatch", () =>
  Effect.gen(function* () {
    for (const support of [undefined, false, true]) {
      const h = yield* harness(support);
      const operations = [
        h.atoms.upsertTicket.run(h.registry, {
          environmentId: env,
          input: { title: "Title" },
        }),
        h.atoms.deleteTicket.run(h.registry, { environmentId: env, input: { id: ticket.id } }),
        h.atoms.restoreTicket.run(h.registry, { environmentId: env, input: { id: ticket.id } }),
        h.atoms.linkTicket.run(h.registry, {
          environmentId: env,
          input: { id: ticket.id, threadId: ThreadId.make("draft"), role: "work" },
        }),
        h.atoms.unlinkTicket.run(h.registry, {
          environmentId: env,
          input: { id: ticket.id, threadId: ThreadId.make("draft") },
        }),
      ];
      for (const operation of operations) {
        yield* Effect.promise(async () => {
          const result = await operation;
          if (support === true) assert.equal(result._tag, "Success");
          else {
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") assert.ok(isUnavailable(Cause.squash(result.cause)));
          }
        });
      }
      assert.equal(h.sent.length, support === true ? 5 : 0);
    }
  }),
);

it.effect("dispatches partial upserts without filling in omitted fields", () =>
  Effect.gen(function* () {
    const h = yield* harness(true);
    const input = { id: ticket.id, status: "in_review" as const };
    yield* Effect.promise(async () => {
      const result = await h.atoms.upsertTicket.run(h.registry, { environmentId: env, input });
      assert.equal(result._tag, "Success");
    });
    assert.deepStrictEqual(h.sent, [{ tag: WS_METHODS.ticketsUpsert, input }]);
  }),
);

it.effect("refuses subscriptions on older servers before calling the RPC", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const live = h.atoms.ticketsLive({ environmentId: env, input: {} });
    yield* AtomRegistry.mount(h.registry, live);
    const error = yield* AtomRegistry.getResult(h.registry, live).pipe(Effect.flip);
    assert.ok(isUnavailable(error));
    assert.equal(h.sent.length, 0);
  }),
);

it.effect("subscription updates its thread index from full environment lists", () =>
  Effect.gen(function* () {
    const h = yield* harness(true);
    const live = h.atoms.ticketsLive({ environmentId: env, input: {} });
    yield* AtomRegistry.mount(h.registry, live);
    const threadId = ThreadId.make("work");
    yield* Queue.offer(h.snapshots, {
      tickets: [{ ...ticket, links: [{ threadId, role: "work", linkedAt: ticket.createdAt }] }],
    });
    const result = yield* AtomRegistry.getResult(h.registry, live);
    assert.equal(result.tickets.length, 1);
    assert.deepStrictEqual(h.registry.get(h.atoms.ticketIdsByThreadAtom(env)).get(threadId), [
      ticket.id,
    ]);
  }),
);

it("indexes multiple tickets and excludes soft-deleted tickets", () => {
  const threadId = ThreadId.make("work");
  const linked = {
    ...ticket,
    links: [{ threadId, role: "work" as const, linkedAt: ticket.createdAt }],
  };
  assert.deepStrictEqual(
    ticketIdsByThread([
      linked,
      { ...linked, id: TicketId.make("ticket:two") },
      { ...linked, id: TicketId.make("deleted"), deletedAt: ticket.createdAt },
    ]).get(threadId),
    [ticket.id, TicketId.make("ticket:two")],
  );
});

// Transport tests grant the operate scope; permission edge cases are covered by commandPermissions.test.ts.
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: grantedSessions }),
}));
const grantedSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationOperateScope],
    }),
  ),
);
