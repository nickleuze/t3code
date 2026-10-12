import {
  CommandId,
  TicketLaunchError,
  TicketLaunchNeedsProject,
  TicketNotFound,
  OrchestratorMcpFailure,
  type TicketStartInput,
  type TicketStartResult,
  type TicketAuthor,
  type TicketError,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { ticketStartPrompt } from "@t3tools/shared/ticket";
import * as Crypto from "effect/Crypto";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Projects from "../project/ProjectService.ts";
import * as Defaults from "../project/ProjectLaunchDefaults.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launches from "../orchestration-v2/ThreadLaunchService.ts";
import {
  exceededDispatchModeLimit,
  type DispatchModes,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as Tickets from "./TicketService.ts";

/** Only these failures prove that the prelink cannot name a committed thread. */
export function rejectedBeforeLaunch(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("_tag" in error)) return false;
  if (error._tag === "EnvironmentAuthorizationError" || error._tag === "AttachmentClaimError")
    return true;
  if (error._tag === "ThreadLaunchError")
    return "operation" in error && error.operation === "resolve-project";
  if (error._tag === "OrchestrationV2ThreadLaunchError" && "cause" in error)
    return rejectedBeforeLaunch(error.cause);
  return false;
}

type StartError =
  | TicketError
  | TicketNotFound
  | TicketLaunchNeedsProject
  | TicketLaunchError
  | OrchestratorMcpFailure;
export class TicketLaunchService extends Context.Service<
  TicketLaunchService,
  {
    readonly start: (
      input: TicketStartInput,
      options?: { readonly by?: TicketAuthor; readonly limits?: DispatchModes },
    ) => Effect.Effect<TicketStartResult, StartError>;
  }
>()("t3/tickets/TicketLaunchService") {}
const make = Effect.gen(function* () {
  const tickets = yield* Tickets.TicketService;
  const projects = yield* Projects.ProjectService;
  const defaults = yield* Defaults.ProjectLaunchDefaults;
  const git = yield* GitWorkflow.GitWorkflowService;
  const threads = yield* Threads.ThreadManagementService;
  const launches = yield* Launches.ThreadLaunchService;
  const crypto = yield* Crypto.Crypto;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const locks = yield* KeyedLock.make<string>();
  const start: TicketLaunchService["Service"]["start"] = (input, options) =>
    locks.withLock(
      input.ticketId,
      Effect.gen(function* () {
        const fail = (operation: TicketLaunchError["operation"]) => (cause: unknown) =>
          new TicketLaunchError({ ticketId: input.ticketId, operation, cause });
        let { ticket } = yield* tickets.get(input.ticketId).pipe(
          Effect.catchTags({
            TicketError: (error) =>
              error.reason === "not_found"
                ? Effect.fail<StartError>(new TicketNotFound({ ticketId: input.ticketId }))
                : Effect.fail<StartError>(error),
          }),
        );
        const existing = yield* threads
          .getThreadShell(input.threadId)
          .pipe(Effect.mapError(fail("read-thread")));
        const receipt = yield* receipts
          .getByCommandId(input.commandId)
          .pipe(Effect.mapError(fail("read-thread")));
        if (
          existing &&
          (Option.isNone(receipt) ||
            receipt.value.status !== "accepted" ||
            receipt.value.threadId !== input.threadId ||
            receipt.value.commandType !== "thread.create")
        )
          return yield* fail("launch")("Thread id belongs to another launch.");
        // Recover the accepted project before a changed key mapping can redirect a retry.
        const projectId = existing?.projectId ?? input.projectId ?? ticket.projectId;
        if (projectId === null)
          return yield* new TicketLaunchNeedsProject({ ticketId: input.ticketId });
        const project = Option.getOrUndefined(
          yield* projects.getById(projectId).pipe(Effect.mapError(fail("resolve-project"))),
        );
        if (!project) return yield* new TicketLaunchNeedsProject({ ticketId: input.ticketId });
        if (
          existing &&
          !ticket.links.some(
            (l) =>
              l.threadId === existing.id &&
              l.machine === tickets.author().machine &&
              l.role === "work",
          )
        )
          return yield* fail("launch")("Thread id belongs to another launch.");
        if (!existing && input.projectId !== undefined && ticket.projectId !== projectId) {
          if (ticket.projectKey) {
            yield* tickets.projectsMap({
              key: ticket.projectKey,
              projectId,
              displayName: ticket.projectName ?? ticket.projectKey,
            });
            ticket = (yield* tickets.get(ticket.id)).ticket;
          } else
            ticket = (yield* tickets.upsert(
              { id: ticket.id, requireExisting: true, projectId },
              options?.by,
            )).ticket;
        }
        const shells = yield* Effect.forEach(
          ticket.links.filter(
            (l) => l.machine === undefined || l.machine === tickets.author().machine,
          ),
          (l) =>
            threads.getThreadShell(l.threadId).pipe(
              Effect.mapError(fail("read-thread")),
              Effect.map((shell) => ({ link: l, shell })),
            ),
        );
        const active = shells.find(
          ({ link, shell }) =>
            link.role === "work" &&
            shell &&
            shell.deletedAt === null &&
            shell.archivedAt === null &&
            (shell.activeRunId !== null ||
              shell.pendingRuntimeRequest !== null ||
              shell.hasActionableProposedPlan ||
              shell.t3Goal?.status === "active" ||
              shell.t3Goal?.needsInput === true),
        );
        if (!existing && !input.allowParallel && active?.shell)
          return {
            status: "already_active",
            threadId: active.shell.id,
            projectId: active.shell.projectId,
            modelSelection: active.shell.modelSelection,
            interactionMode: active.shell.interactionMode,
          };
        const resolved = yield* defaults
          .resolve(project)
          .pipe(Effect.mapError(fail("resolve-model")));
        const modelSelection =
          existing?.modelSelection ?? input.modelSelection ?? resolved.modelSelection;
        if (!modelSelection)
          return yield* new TicketLaunchError({
            ticketId: input.ticketId,
            operation: "resolve-model",
          });
        let runtimeMode =
          existing?.runtimeMode ??
          (yield* defaults.runtimeMode(input.runtimeMode ?? resolved.runtimeMode, modelSelection));
        const interactionMode =
          existing?.interactionMode ??
          (input.mode === undefined || input.mode === "plan" ? "plan" : "default");
        if (options?.limits) {
          // Omitted MCP runtime uses project defaults within the caller's ceiling.
          if (
            input.runtimeMode === undefined &&
            exceededDispatchModeLimit(options.limits, { runtimeMode, interactionMode: "plan" }) ===
              "runtime"
          )
            runtimeMode = yield* defaults.runtimeMode(options.limits.runtimeMode, modelSelection);
          const exceeded = exceededDispatchModeLimit(options.limits, {
            runtimeMode,
            interactionMode,
          });
          if (exceeded)
            return yield* new OrchestratorMcpFailure({
              code:
                exceeded === "runtime"
                  ? "runtime_mode_escalation_denied"
                  : "interaction_mode_escalation_denied",
              message: "Ticket launch exceeds the caller's permission modes.",
            });
        }
        const records = existing
          ? yield* threads
              .getThreadRecords(input.threadId, ["runs", "messages"])
              .pipe(Effect.mapError(fail("read-thread")))
          : undefined;
        const firstRun = records?.runs.find((run) => run.ordinal === 1);
        const prompt =
          records?.messages.find((message) => message.id === firstRun?.userMessageId)?.text ??
          ticketStartPrompt(
            ticket,
            shells
              .filter(({ link }) => link.role !== "origin")
              .flatMap(({ shell }) => shell?.branch ?? []),
          );
        const branchHash = Array.from(
          yield* crypto
            .digest("SHA-256", new TextEncoder().encode(input.threadId))
            .pipe(Effect.mapError(fail("launch"))),
          (b) => b.toString(16).padStart(2, "0"),
        )
          .join("")
          .slice(0, 12);
        // A worktree needs a repository with a commit. Tickets also launch non-coding work.
        const useWorktree =
          !firstRun?.workspacePreparation && resolved.envMode !== "local"
            ? yield* Effect.gen(function* () {
                if (!(yield* git.isRepository(project.workspaceRoot))) return false;
                return yield* git.hasCommit({ cwd: project.workspaceRoot, refName: "HEAD" });
              }).pipe(Effect.mapError(fail("resolve-project")))
            : false;
        const workspaceStrategy: Launches.ThreadLaunchWorkspaceStrategy =
          firstRun?.workspacePreparation ??
          (!useWorktree
            ? { type: "root" }
            : {
                type: "worktree",
                baseRef: "HEAD",
                branch: `ticket/${ticket.id.slice(-8).toLowerCase()}-${
                  ticket.title
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "")
                    .slice(0, 48) || "work"
                }-${branchHash}`,
              });
        yield* tickets.link(
          { id: ticket.id, threadId: input.threadId, role: "work", title: ticket.title },
          options?.by,
        );
        yield* launches
          .launch({
            commandId: input.commandId,
            threadId: input.threadId,
            projectId,
            title: existing?.title ?? ticket.title,
            modelSelection,
            runtimeMode,
            interactionMode,
            workspaceStrategy,
            ...(input.mode === "goal" ? {} : { initialMessage: { text: prompt, attachments: [] } }),
            createdBy: input.creationSource === "mcp" ? "agent" : "user",
            creationSource: input.creationSource,
          })
          .pipe(
            Effect.tapError((error) =>
              !existing && rejectedBeforeLaunch(error)
                ? tickets
                    .unlink({ id: ticket.id, threadId: input.threadId }, options?.by)
                    .pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.mapError(fail("launch")),
          );
        if (input.mode === "goal")
          yield* threads
            .dispatch({
              type: "thread.goal.set",
              threadId: input.threadId,
              commandId: CommandId.make(`ticket-goal:${input.commandId}`),
              objective: prompt,
            })
            .pipe(Effect.mapError(fail("goal")));
        return {
          status: "launched",
          threadId: input.threadId,
          projectId,
          modelSelection,
          interactionMode,
        };
      }),
    );
  return TicketLaunchService.of({ start });
});
export const layer = Layer.effect(TicketLaunchService, make);
