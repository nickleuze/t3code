import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, RepositoryIdentity, TicketError } from "@t3tools/contracts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tickets from "./TicketService.ts";
import * as Github from "./TicketGithubService.ts";
import { deriveTicketStatus } from "@t3tools/shared/ticket";

const projectId = ProjectId.make("github-project");
const repositoryIdentity = Schema.decodeSync(RepositoryIdentity)({
  canonicalKey: "github.com/acme/project",
  displayName: "acme/project",
  provider: "github",
  owner: "acme",
  name: "project",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/project.git",
  },
});
const issue = (number: number, closed = false) => ({
  number,
  title: `Issue ${number}`,
  body: "**Issue body**",
  html_url: `https://github.com/acme/project/issues/${number}`,
  state: closed ? ("closed" as const) : ("open" as const),
  closed_at: closed ? "2026-10-11T12:00:00.000Z" : null,
});
class Fixture extends Context.Service<
  Fixture,
  {
    api: GitHubApi.GitHubApi["Service"];
    calls: { method: string; path: string; body?: unknown }[];
    issues: Map<number, ReturnType<typeof issue>>;
    failures: Set<number>;
    missingAuth: boolean;
    batchFailed: boolean;
    batches: number;
    beforeBatch: Effect.Effect<void>;
  }
>()("t3/tickets/TicketGithubService.test/Fixture") {}
const fixtureLayer = Layer.sync(Fixture, () => {
  const fixture: Fixture["Service"] = {
    calls: [],
    issues: new Map([
      [1, issue(1)],
      [2, issue(2, true)],
    ]),
    failures: new Set(),
    missingAuth: false,
    batchFailed: false,
    batches: 0,
    beforeBatch: Effect.void,
    api: {
      credential: () => Effect.die("unused credential read"),
      rest: (input) =>
        Effect.gen(function* () {
          fixture.calls.push({
            method: input.method ?? "GET",
            path: input.path,
            ...(input.body ? { body: input.body } : {}),
          });
          if (fixture.missingAuth)
            return yield* new GitHubApi.GitHubApiAuthenticationError({
              host: input.host,
              operation: input.operation,
            });
          const number = input.method === "POST" ? 3 : Number(input.path.split("/").at(-1));
          if (fixture.failures.has(number))
            return yield* new GitHubApi.GitHubApiNotFoundError({
              host: input.host,
              operation: input.operation,
            });
          const response = fixture.issues.get(number) ?? issue(number);
          return {
            status: 200,
            headers: {},
            body: JSON.stringify(response),
            truncated: false,
            invalidUtf8: false,
          };
        }),
      graphql: (input) =>
        Effect.gen(function* () {
          fixture.batches++;
          yield* fixture.beforeBatch;
          if (fixture.batchFailed)
            return yield* new GitHubApi.GitHubApiResponseError({
              host: input.host,
              operation: input.operation,
              status: 200,
            });
          const data: Record<string, unknown> = {};
          for (const match of input.query.matchAll(
            /(i\d+): repository\(.+?issue\(number: (\d+)\)/gu,
          )) {
            const number = Number(match[2]);
            const value = fixture.issues.get(number) ?? issue(number);
            data[match[1]!] = fixture.failures.has(number)
              ? null
              : { issue: { state: value.state.toUpperCase(), closedAt: value.closed_at } };
          }
          return JSON.stringify({ data });
        }),
    },
  };
  return fixture;
});
const projectLayer = Layer.mock(ProjectService.ProjectService)({
  getShell: (id) =>
    Effect.succeedSome({
      id,
      title: "Project",
      workspaceRoot: id === projectId ? "/tmp/ticket-github" : "/tmp/no-repo",
      repositoryIdentity: id === projectId ? repositoryIdentity : null,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    }),
});
const ticketLayer = Tickets.layer.pipe(
  Layer.provide(Layer.mergeAll(ProjectStore.layer, NodeCrypto.layer)),
);
const layer = Github.layer.pipe(
  Layer.provideMerge(ticketLayer),
  Layer.provide(
    Layer.mergeAll(
      projectLayer,
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: (cwd) => Effect.succeed(cwd === "/tmp/ticket-github" ? repositoryIdentity : null),
      }),
      Layer.effect(
        GitHubApi.GitHubApi,
        Effect.map(Fixture, (f) => f.api),
      ),
    ),
  ),
  Layer.provideMerge(fixtureLayer),
  Layer.provideMerge(Sqlite.layerMemory),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Project', '/tmp/ticket-github', '[]', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`;
});
const failure = <A>(effect: Effect.Effect<A, TicketError>) => Effect.flip(effect);

it.effect("publish is idempotent, including concurrent calls, and adds the footer", () =>
  Effect.gen(function* () {
    yield* seed;
    const tickets = yield* Tickets.TicketService;
    const github = yield* Github.TicketGithubService;
    const fixture = yield* Fixture;
    const { ticket } = yield* tickets.upsert({ title: "Publish", body: "Body", projectId });
    const results = yield* Effect.all(
      [github.publishIssue({ id: ticket.id }), github.publishIssue({ id: ticket.id })],
      { concurrency: 2 },
    );
    assert.deepStrictEqual(results[0], results[1]);
    assert.equal(results[0]!.ticket.githubIssue?.repository, "github.com/acme/project");
    assert.equal(results[0]!.ticket.statusSetAt, ticket.statusSetAt);
    assert.deepStrictEqual(fixture.calls, [
      {
        method: "POST",
        path: "repos/acme/project/issues",
        body: { title: "Publish", body: "Body\n\nFiled from T3" },
      },
    ]);
    const unlinked = yield* github.unlinkIssue({ id: ticket.id });
    assert.equal(unlinked.ticket.githubIssue, null);
    assert.equal(unlinked.ticket.statusSetAt, ticket.statusSetAt);
  }).pipe(Effect.provide(layer)),
);

it.effect("imports URL and #number once and explicitly marks closed imports done", () =>
  Effect.gen(function* () {
    yield* seed;
    const github = yield* Github.TicketGithubService;
    const tickets = yield* Tickets.TicketService;
    const fixture = yield* Fixture;
    const first = yield* github.importIssue({
      projectId,
      issue: "https://github.com/acme/project/issues/1",
    });
    const same = yield* github.importIssue({ projectId, issue: "#1" });
    assert.deepStrictEqual(first, same);
    assert.equal(first.ticket.title, "Issue 1");
    assert.equal(first.ticket.body, "**Issue body**");
    assert.equal(first.ticket.creationSource, "github");
    assert.equal(first.ticket.status, "inbox");
    assert.equal(fixture.calls.length, 1);
    const closed = yield* github.importIssue({ projectId, issue: 2 });
    assert.equal(closed.ticket.status, "done");
    assert.equal(closed.ticket.githubIssue?.closedAt, "2026-10-11T12:00:00.000Z");
    yield* tickets.delete({ id: first.ticket.id });
    const reimported = yield* github.importIssue({ projectId, issue: 1 });
    assert.notEqual(reimported.ticket.id, first.ticket.id);
    assert.equal((yield* tickets.list()).tickets.length, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects absent repositories, mismatched URLs, pull requests, and auth failures", () =>
  Effect.gen(function* () {
    yield* seed;
    const github = yield* Github.TicketGithubService;
    const tickets = yield* Tickets.TicketService;
    const fixture = yield* Fixture;
    const { ticket } = yield* tickets.upsert({ title: "No repo" });
    assert.match(
      (yield* failure(github.publishIssue({ id: ticket.id }))).message,
      /no GitHub repository/u,
    );
    for (const issue of [
      "https://github.com/other/repo/issues/1",
      "https://github.com/acme/project/pull/1",
      "#0",
      "-2",
      "https://attacker.invalid/acme/project/issues/1",
    ]) {
      yield* failure(github.importIssue({ projectId, issue }));
    }
    assert.equal(fixture.calls.length, 0);
    fixture.issues.set(1, Object.assign(issue(1), { pull_request: {} }));
    assert.match(
      (yield* failure(github.importIssue({ projectId, issue: 1 }))).message,
      /pull request/u,
    );
    fixture.missingAuth = true;
    const assigned = (yield* tickets.upsert({ title: "Auth", projectId })).ticket;
    assert.match((yield* failure(github.publishIssue({ id: assigned.id }))).message, /credential/u);
    assert.equal(
      (yield* tickets.list()).tickets.find((t) => t.id === assigned.id)?.githubIssue,
      null,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("refresh batches, throttles for five minutes, forces and salvages partial failures", () =>
  Effect.gen(function* () {
    yield* seed;
    const github = yield* Github.TicketGithubService;
    const tickets = yield* Tickets.TicketService;
    const fixture = yield* Fixture;
    const first = (yield* github.importIssue({ projectId, issue: 1 })).ticket;
    const closed = (yield* github.importIssue({ projectId, issue: 2 })).ticket;
    assert.deepStrictEqual(yield* github.refreshIssues({}), {
      refreshed: 2,
      failed: 0,
      skipped: false,
    });
    assert.equal(fixture.batches, 1);
    assert.deepStrictEqual(yield* github.refreshIssues({}), {
      refreshed: 0,
      failed: 0,
      skipped: true,
    });
    yield* TestClock.adjust("5 minutes");
    assert.deepStrictEqual(yield* github.refreshIssues({}), {
      refreshed: 2,
      failed: 0,
      skipped: false,
    });
    const prior = (yield* tickets.list()).tickets.find((t) => t.id === closed.id)!;
    fixture.batchFailed = true;
    fixture.failures.add(2);
    fixture.issues.set(1, issue(1, true));
    assert.deepStrictEqual(yield* github.refreshIssues({ force: true }), {
      refreshed: 1,
      failed: 1,
      skipped: false,
    });
    const after = (yield* tickets.list()).tickets;
    assert.deepStrictEqual(
      after.find((t) => t.id === closed.id),
      prior,
    );
    assert.equal(after.find((t) => t.id === first.id)?.githubIssue?.state, "closed");
    yield* tickets.delete({ id: closed.id });
    assert.deepStrictEqual(yield* github.refreshIssues({ force: true }), {
      refreshed: 1,
      failed: 0,
      skipped: false,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("manual reopen after close survives subsequent refreshes; a later close advances", () =>
  Effect.gen(function* () {
    yield* seed;
    const github = yield* Github.TicketGithubService;
    const tickets = yield* Tickets.TicketService;
    const fixture = yield* Fixture;
    const ticket = (yield* github.importIssue({ projectId, issue: 2 })).ticket;
    yield* TestClock.setTime(Date.parse("2026-10-11T13:00:00.000Z"));
    yield* tickets.upsert({ id: ticket.id, status: "ready" });
    for (let refresh = 0; refresh < 2; refresh++) {
      yield* TestClock.adjust("5 minutes");
      yield* github.refreshIssues({ force: true });
      const current = (yield* tickets.list()).tickets[0]!;
      assert.equal(
        deriveTicketStatus(current, () => undefined),
        "ready",
      );
    }
    fixture.issues.set(2, { ...issue(2, true), closed_at: "2026-10-11T14:00:00.000Z" });
    yield* github.refreshIssues({ force: true });
    assert.equal(
      deriveTicketStatus((yield* tickets.list()).tickets[0]!, () => undefined),
      "done",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("resolves repository identity when non-blocking shell enrichment is absent", () =>
  Effect.gen(function* () {
    yield* seed;
    const github = yield* Github.TicketGithubService;
    const imported = yield* github.importIssue({ projectId, issue: 1 });
    assert.equal(imported.ticket.githubIssue?.repository, "github.com/acme/project");
  }).pipe(
    Effect.provide(
      Github.layer.pipe(
        Layer.provideMerge(ticketLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              getShell: (id) =>
                Effect.succeedSome({
                  id,
                  title: "Project",
                  workspaceRoot: "/tmp/ticket-github",
                  repositoryIdentity: null,
                  defaultModelSelection: null,
                  defaultThreadEnvMode: null,
                  autoPull: false,
                  faviconPath: null,
                  projectIcon: null,
                  scripts: [],
                  createdAt: "2026-10-11T00:00:00.000Z",
                  updatedAt: "2026-10-11T00:00:00.000Z",
                }),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(repositoryIdentity),
            }),
            Layer.effect(
              GitHubApi.GitHubApi,
              Effect.map(Fixture, (f) => f.api),
            ),
          ),
        ),
        Layer.provide(fixtureLayer),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
);

it.effect("refresh publishes one complete snapshot for multiple successful reads", () =>
  Effect.gen(function* () {
    yield* seed;
    const github = yield* Github.TicketGithubService;
    const tickets = yield* Tickets.TicketService;
    const fixture = yield* Fixture;
    yield* github.importIssue({ projectId, issue: 1 });
    yield* github.importIssue({ projectId, issue: 2 });
    const snapshots = yield* Queue.unbounded<import("@t3tools/contracts").TicketListResult>();
    yield* tickets.subscribeList().pipe(
      Stream.runForEach((list) => Queue.offer(snapshots, list)),
      Effect.forkChild,
    );
    yield* Queue.take(snapshots);
    fixture.issues.set(1, issue(1, true));
    yield* github.refreshIssues({});
    const snapshot = yield* Queue.take(snapshots);
    assert.equal(snapshot.tickets.length, 2);
    assert.ok(snapshot.tickets.every((ticket) => ticket.githubIssue?.state === "closed"));
    assert.equal(yield* Queue.size(snapshots), 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("refresh skips a ticket deleted while remote reads are in flight", () =>
  Effect.gen(function* () {
    yield* seed;
    const github = yield* Github.TicketGithubService;
    const tickets = yield* Tickets.TicketService;
    const fixture = yield* Fixture;
    const deleted = (yield* github.importIssue({ projectId, issue: 1 })).ticket;
    yield* github.importIssue({ projectId, issue: 2 });
    fixture.beforeBatch = tickets.delete({ id: deleted.id }).pipe(Effect.asVoid, Effect.orDie);
    assert.deepStrictEqual(yield* github.refreshIssues({}), {
      refreshed: 1,
      failed: 0,
      skipped: false,
    });
    assert.equal((yield* tickets.list()).tickets.length, 1);
    const saved = (yield* tickets.list({ includeDeleted: true })).tickets.find(
      (t) => t.id === deleted.id,
    )!;
    assert.equal(saved.githubIssue?.state, "open");
  }).pipe(Effect.provide(layer)),
);

it.effect("subscription start requests a throttled refresh without blocking its initial list", () =>
  Effect.gen(function* () {
    yield* seed;
    const github = yield* Github.TicketGithubService;
    const fixture = yield* Fixture;
    yield* github.importIssue({ projectId, issue: 1 });
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    fixture.beforeBatch = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    fixture.issues.set(1, issue(1, true));
    const snapshots = yield* Queue.unbounded<import("@t3tools/contracts").TicketListResult>();
    yield* github.subscribeList().pipe(
      Stream.runForEach((list) => Queue.offer(snapshots, list)),
      Effect.forkChild,
    );
    const initial = yield* Queue.take(snapshots);
    assert.equal(initial.tickets[0]!.githubIssue?.state, "open");
    yield* Deferred.await(started);
    yield* Deferred.succeed(release, undefined);
    const refreshed = yield* Queue.take(snapshots);
    assert.equal(refreshed.tickets[0]!.githubIssue?.state, "closed");
    assert.deepStrictEqual(yield* github.refreshIssues({}), {
      refreshed: 0,
      failed: 0,
      skipped: true,
    });
    assert.equal(fixture.batches, 1);
  }).pipe(Effect.provide(layer)),
);
