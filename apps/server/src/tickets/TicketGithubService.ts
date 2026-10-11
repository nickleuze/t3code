import {
  IsoDateTime,
  TicketError,
  TicketGithubIssue,
  pullRequestHostOf,
  type ProjectId,
  type TicketId,
  type TicketImportIssueInput,
  type TicketMutationResult,
  type TicketPublishIssueInput,
  type TicketRefreshIssuesInput,
  type TicketRefreshIssuesResult,
  type TicketUnlinkIssueInput,
} from "@t3tools/contracts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Tickets from "./TicketService.ts";

const IssueResponse = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  closed_at: Schema.NullOr(IsoDateTime),
  pull_request: Schema.optionalKey(Schema.Unknown),
});
const IssueState = Schema.Struct({
  state: Schema.Literals(["OPEN", "CLOSED"]),
  closedAt: Schema.NullOr(IsoDateTime),
});
const decodeLinkedIssue = Schema.decodeEffect(TicketGithubIssue);
const isTicketError = Schema.is(TicketError);
const isSafeApiError = Schema.is(
  Schema.Union([
    GitHubApi.GitHubApiAuthenticationError,
    GitHubApi.GitHubApiNotFoundError,
    GitHubApi.GitHubApiRateLimitError,
  ]),
);
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueResponse));
const decodeStates = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Struct({
            issue: Schema.NullOr(IssueState),
          }),
        ),
      ),
    }),
  ),
);

// Links include the host so GitHub Enterprise issue numbers never collide with github.com.
function repositoryParts(repository: string) {
  const parts = repository.split("/");
  const [host, owner, name] = parts.length === 2 ? ["github.com", ...parts] : parts;
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    !host ||
    !owner ||
    !name ||
    !/^[a-z0-9.-]+(?::\d+)?$/iu.test(host) ||
    !/^[a-z0-9_-]+$/iu.test(owner) ||
    !/^[a-z0-9_.-]+$/iu.test(name) ||
    name === "." ||
    name === ".."
  ) {
    return null;
  }
  return {
    host: host.toLowerCase(),
    owner,
    name,
    repository: `${host}/${owner}/${name}`.toLowerCase(),
  };
}

export class TicketGithubService extends Context.Service<
  TicketGithubService,
  {
    readonly publishIssue: (
      input: TicketPublishIssueInput,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly importIssue: (
      input: TicketImportIssueInput,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly unlinkIssue: (
      input: TicketUnlinkIssueInput,
    ) => Effect.Effect<TicketMutationResult, TicketError>;
    readonly refreshIssues: (
      input: TicketRefreshIssuesInput,
    ) => Effect.Effect<TicketRefreshIssuesResult, TicketError>;
  }
>()("t3/tickets/TicketGithubService") {}

const make = Effect.gen(function* () {
  const tickets = yield* Tickets.TicketService;
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const api = yield* GitHubApi.GitHubApi;
  // ponytail: serialize issue operations; split per-ticket locks if large boards delay publishes.
  const lock = yield* Semaphore.make(1);
  let lastRefresh: number | undefined;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const load = Effect.fn("TicketGithubService.load")(function* (
    id: TicketId,
    includeDeleted = false,
  ) {
    const ticket = (yield* tickets.list({ includeDeleted })).tickets.find(
      (ticket) => ticket.id === id,
    );
    if (!ticket) return yield* new TicketError({ message: "Ticket not found.", ticketId: id });
    return ticket;
  });
  const repositoryFor = Effect.fn("TicketGithubService.repositoryFor")(function* (
    projectId: ProjectId | null,
  ) {
    const project =
      projectId === null ? undefined : Option.getOrUndefined(yield* projects.getShell(projectId));
    // Shell enrichment is non-blocking and can expire before this action arrives.
    const identity =
      project?.repositoryIdentity ??
      (project === undefined ? null : yield* identities.resolve(project.workspaceRoot));
    const selector = sourceControlRepositorySelector(identity);
    const repository =
      identity?.provider === "github" && selector !== null
        ? repositoryParts(`${pullRequestHostOf(identity, "github")}/${selector}`)
        : null;
    if (!repository)
      return yield* new TicketError({
        message:
          "This ticket's project has no GitHub repository. Choose a GitHub project and retry.",
      });
    return repository;
  });
  const readIssue = Effect.fn("TicketGithubService.readIssue")(function* (
    repository: NonNullable<ReturnType<typeof repositoryParts>>,
    number: number,
  ) {
    const response = yield* api.rest({
      host: repository.host,
      operation: "tickets.readIssue",
      path: `repos/${repository.owner}/${repository.name}/issues/${number}`,
    });
    const issue = yield* decodeIssue(response.body);
    if (issue.pull_request !== undefined)
      return yield* new TicketError({
        message: "This reference is a pull request. Import a GitHub issue instead.",
      });
    return issue;
  });
  const linkedIssue = Effect.fn("TicketGithubService.linkedIssue")(function* (
    repository: NonNullable<ReturnType<typeof repositoryParts>>,
    issue: typeof IssueResponse.Type,
  ) {
    // Derive the link from the trusted project identity, not an arbitrary response URL.
    return yield* decodeLinkedIssue({
      repository: repository.repository,
      number: issue.number,
      url: `https://${repository.host}/${repository.owner}/${repository.name}/issues/${issue.number}`,
      state: issue.state,
      closedAt: issue.closed_at,
      syncedAt: yield* now,
    });
  });
  const mapError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => {
        if (isTicketError(cause)) return cause;
        // Credential/API errors have safe, deliberately user-facing messages. Never copy defect text.
        if (isSafeApiError(cause)) return new TicketError({ message: cause.message, cause });
        return new TicketError({
          message:
            "GitHub issue operation failed. Check the server's GitHub credentials in Settings → Source Control or run gh auth status on the server.",
          cause,
        });
      }),
    );
  const publishIssue: TicketGithubService["Service"]["publishIssue"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const ticket = yield* load(input.id);
        if (ticket.githubIssue !== null) return { ticket };
        const repository = yield* repositoryFor(ticket.projectId);
        const response = yield* api.rest({
          host: repository.host,
          operation: "tickets.publishIssue",
          method: "POST",
          path: `repos/${repository.owner}/${repository.name}/issues`,
          body: {
            title: ticket.title,
            body: [ticket.body, "Filed from T3"].filter(Boolean).join("\n\n"),
          },
        });
        const issue = yield* linkedIssue(repository, yield* decodeIssue(response.body));
        yield* tickets.setGithubIssues([{ id: ticket.id, issue }]);
        return { ticket: yield* load(ticket.id, true) };
      }).pipe(Effect.uninterruptible, mapError),
    );
  const importIssue: TicketGithubService["Service"]["importIssue"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const repository = yield* repositoryFor(input.projectId);
        const reference = String(input.issue).trim();
        let number = Number(reference.replace(/^#/u, ""));
        if (!/^#?\d+$/u.test(reference)) {
          const url = URL.parse(reference);
          const match = url?.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/u);
          if (
            !url ||
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !match ||
            `${url.host}/${match[1]}/${match[2]}`.toLowerCase() !== repository.repository
          )
            return yield* new TicketError({
              message:
                "Enter an issue URL from the selected project's GitHub repository, or a positive issue number.",
            });
          number = Number(match[3]);
        }
        if (!Number.isSafeInteger(number) || number <= 0)
          return yield* new TicketError({ message: "Enter a positive GitHub issue number." });
        const existing = (yield* tickets.list()).tickets.find(
          (ticket) =>
            ticket.githubIssue?.repository.toLowerCase() === repository.repository &&
            ticket.githubIssue.number === number,
        );
        if (existing) return { ticket: existing };
        const issue = yield* readIssue(repository, number);
        return yield* tickets.importGithubIssue(
          {
            projectId: input.projectId,
            title: issue.title,
            body: issue.body ?? "",
            creationSource: "github",
            status: issue.state === "closed" ? "done" : "inbox",
          },
          yield* linkedIssue(repository, issue),
        );
      }).pipe(mapError),
    );
  const unlinkIssue: TicketGithubService["Service"]["unlinkIssue"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        yield* load(input.id);
        yield* tickets.setGithubIssues([{ id: input.id, issue: null }]);
        return { ticket: yield* load(input.id) };
      }),
    );
  const refreshIssues: TicketGithubService["Service"]["refreshIssues"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;
        if (!input.force && lastRefresh !== undefined && timestamp - lastRefresh < 300_000)
          return { refreshed: 0, failed: 0, skipped: true };
        lastRefresh = timestamp;
        const active = (yield* tickets.list()).tickets.filter(
          (ticket) => ticket.githubIssue !== null,
        );
        const groups = new Map<string, typeof active>();
        let failed = 0;
        const updates: { id: TicketId; issue: TicketGithubIssue }[] = [];
        for (const ticket of active) {
          const repository = repositoryParts(ticket.githubIssue!.repository);
          if (!repository) {
            failed++;
            continue;
          }
          const group = groups.get(repository.host) ?? [];
          group.push(ticket);
          groups.set(repository.host, group);
        }
        for (const [host, group] of groups) {
          // Small aliased batches avoid a request per ticket and bound query size.
          for (let offset = 0; offset < group.length; offset += 25) {
            const batch = group.slice(offset, offset + 25);
            const query = `query { ${batch
              .map((ticket, index) => {
                const repository = repositoryParts(ticket.githubIssue!.repository)!;
                return `i${index}: repository(owner: ${JSON.stringify(repository.owner)}, name: ${JSON.stringify(repository.name)}) { issue(number: ${ticket.githubIssue!.number}) { state closedAt } }`;
              })
              .join(" ")} }`;
            const states = yield* api
              .graphql({ host, operation: "tickets.refreshIssues", query })
              .pipe(Effect.flatMap(decodeStates), Effect.option);
            for (const [index, ticket] of batch.entries()) {
              const old = ticket.githubIssue!;
              let state = Option.getOrUndefined(states)?.data[`i${index}`]?.issue;
              if (!state) {
                // A batch can fail for one inaccessible issue; salvage the other issues individually.
                const issue = yield* readIssue(repositoryParts(old.repository)!, old.number).pipe(
                  Effect.option,
                );
                if (Option.isSome(issue))
                  state = {
                    state: issue.value.state === "closed" ? "CLOSED" : "OPEN",
                    closedAt: issue.value.closed_at,
                  };
              }
              if (!state) {
                failed++;
                continue;
              }
              updates.push({
                id: ticket.id,
                issue: {
                  ...old,
                  state: state.state === "CLOSED" ? "closed" : "open",
                  closedAt: state.closedAt,
                  syncedAt: yield* now,
                },
              });
            }
          }
        }
        // Deleted/unlinked tickets may change while the remote reads are in flight.
        const current = (yield* tickets.list()).tickets;
        const applicable = updates.filter(({ id, issue }) =>
          current.some(
            (ticket) =>
              ticket.id === id &&
              ticket.githubIssue?.repository === issue.repository &&
              ticket.githubIssue.number === issue.number,
          ),
        );
        const refreshed =
          applicable.length > 0
            ? yield* tickets.setGithubIssues(
                applicable.map((update) => ({ ...update, refresh: true })),
              )
            : 0;
        return { refreshed, failed, skipped: false };
      }).pipe(mapError),
    );
  return TicketGithubService.of({ publishIssue, importIssue, unlinkIssue, refreshIssues });
});

export const layer = Layer.effect(TicketGithubService, make);
