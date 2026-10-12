/**
 * Triage: decides what a new Idea becomes as soon as it is created.
 *
 * Reacts only to `created` changes for key-less inbox tickets created on this
 * machine, so its own edits (and the other Mac's synced Ideas) never retrigger
 * it. A deterministic pre-pass files Ideas that name exactly one known Project
 * or Area; anything else goes to the pluggable classifier. Confident matches
 * get a project key, status ready and a decision entry. New Projects and
 * unsure cases stay in the Inbox with a "Needs Nick" question entry. Agents
 * never create Projects or Areas: a verdict naming an unknown key is treated
 * as a best guess.
 *
 * @module TicketTriage
 */
import { CommandId, type ThreadId, type TicketId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Settings from "../serverSettings.ts";
import * as Tickets from "./TicketService.ts";

export type TriageCandidate = {
  readonly key: string;
  readonly name: string;
  readonly area?: string | undefined;
  readonly goal?: string | undefined;
};
export type TriageTicketRef = {
  readonly id: TicketId;
  readonly readableId: string | null;
  readonly title: string;
  readonly projectKey: string | null;
};
export type TriageInput = {
  readonly idea: { readonly id: TicketId; readonly title: string; readonly body: string };
  readonly candidates: ReadonlyArray<TriageCandidate>;
  readonly duplicates: ReadonlyArray<TriageTicketRef>;
  readonly openTickets: ReadonlyArray<TriageTicketRef>;
};
export type TriageVerdict =
  | { readonly kind: "match"; readonly projectKey: string; readonly reason: string }
  | { readonly kind: "new_project"; readonly reason: string; readonly suggestedName?: string }
  | { readonly kind: "unsure"; readonly reason: string; readonly bestGuess?: string }
  /** The classifier handed the Idea to an agent thread that records its own decision. */
  | { readonly kind: "delegated"; readonly threadId: ThreadId };

/** Classifies Ideas the deterministic pre-pass could not place. `null` abstains. */
export class TicketTriageClassifier extends Context.Service<
  TicketTriageClassifier,
  { readonly classify: (input: TriageInput) => Effect.Effect<TriageVerdict | null> }
>()("t3/tickets/TicketTriage/TicketTriageClassifier") {}

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "into", "this", "that"]);
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (haystack: string, needle: string) =>
  needle.trim().length > 1 &&
  new RegExp(`(^|[^a-z0-9-])${escape(needle.trim().toLowerCase())}($|[^a-z0-9-])`).test(haystack);

/** Files an Idea that names exactly one candidate's key or name; abstains otherwise. */
function deterministicTriage(input: TriageInput): TriageVerdict | null {
  const text = `${input.idea.title}\n${input.idea.body}`.toLowerCase();
  const hits = input.candidates.filter(
    (candidate) => mentions(text, candidate.key) || mentions(text, candidate.name),
  );
  if (hits.length === 1)
    return {
      kind: "match",
      projectKey: hits[0]!.key,
      reason: `the Idea names "${hits[0]!.name}"`,
    };
  if (hits.length > 1)
    return {
      kind: "unsure",
      reason: `the Idea names several Projects (${hits.map((hit) => hit.key).join(", ")})`,
      bestGuess: hits[0]!.key,
    };
  return null;
}

/** Open tickets whose titles say the same thing as the Idea's. */
export function findDuplicates(
  idea: { readonly id: TicketId; readonly title: string },
  open: ReadonlyArray<TriageTicketRef>,
): TriageTicketRef[] {
  const mine = new Set(words(idea.title));
  if (mine.size === 0) return [];
  return open.filter((ticket) => {
    if (ticket.id === idea.id) return false;
    const theirs = new Set(words(ticket.title));
    const shared = [...mine].filter((word) => theirs.has(word)).length;
    const union = new Set([...mine, ...theirs]).size;
    return shared === union || (shared >= 2 && shared / union >= 0.75);
  });
}

/** Reads `area` and `goal` from a Project Home README's frontmatter. */
export function readmeFrontmatter(readme: string): { area?: string; goal?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readme);
  if (!match) return {};
  const result: { area?: string; goal?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(area|goal):\s*(.*)$/.exec(line);
    if (!field) continue;
    const value = field[2]!
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (value) result[field[1] as "area" | "goal"] = value;
  }
  return result;
}

const ref = (ticket: TriageTicketRef) => ticket.readableId ?? ticket.id;
const clause = (text: string) => text.trim().replace(/[.\s]+$/, "");

export const make = Effect.gen(function* () {
  const tickets = yield* Tickets.TicketService;
  const settings = yield* Settings.ServerSettingsService;
  const classifier = yield* TicketTriageClassifier;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const machine = tickets.author().machine;
  const by = tickets.author({ actor: "agent" });

  const candidates = Effect.gen(function* () {
    const { projects: known } = yield* tickets.projectsList;
    return yield* Effect.forEach(known, (project) =>
      Effect.gen(function* () {
        const row =
          project.projectId === null
            ? Option.none()
            : yield* projects.get(project.projectId).pipe(Effect.orElseSucceed(Option.none));
        const readme = Option.isSome(row)
          ? yield* fs
              .readFileString(path.join(row.value.workspaceRoot, "README.md"))
              .pipe(Effect.orElseSucceed(() => ""))
          : "";
        return { key: project.key, name: project.displayName, ...readmeFrontmatter(readme) };
      }),
    );
  });

  const triage = (id: TicketId) =>
    Effect.gen(function* () {
      if (!(yield* settings.getSettings).ticketTriage) return;
      const { ticket } = yield* tickets.get(id);
      if (ticket.projectKey || ticket.status !== "inbox" || ticket.deletedAt !== null) return;
      const { events } = yield* tickets.timeline({ id });
      // The machine that captured the Idea triages it; synced Ideas are not re-triaged.
      const created = events.find((event) => event.type === "created");
      if (created?.by.machine !== machine) return;
      const known = yield* candidates;
      const openTickets = (yield* tickets.list()).tickets
        .filter(
          (t) =>
            t.id !== id && t.deletedAt === null && t.status !== "done" && t.status !== "dropped",
        )
        .map((t) => ({
          id: t.id,
          readableId: t.readableId ?? null,
          title: t.title,
          projectKey: t.projectKey ?? null,
        }));
      const input: TriageInput = {
        idea: { id, title: ticket.title, body: ticket.body },
        candidates: known,
        duplicates: findDuplicates({ id, title: ticket.title }, openTickets),
        openTickets,
      };
      const verdict = deterministicTriage(input) ?? (yield* classifier.classify(input));
      if (verdict?.kind === "delegated") return;
      const entry = (kind: "decision" | "question", text: string) =>
        tickets.entry({ id, kind, text, clientRequestId: `triage:${id}` }, by, "triage");
      const duplicateNote = input.duplicates.length
        ? ` Possible duplicate of ${input.duplicates.map(ref).join(", ")}.`
        : "";
      const match =
        verdict?.kind === "match"
          ? known.find((candidate) => candidate.key === verdict.projectKey)
          : undefined;
      if (verdict?.kind === "match" && match && !input.duplicates.length) {
        yield* tickets.upsert({ id, projectKey: match.key, status: "ready" }, by);
        yield* entry(
          "decision",
          `Triage: filed under ${match.name} (${match.key}) because ${clause(verdict.reason)}.`,
        );
        return;
      }
      const text =
        verdict?.kind === "new_project"
          ? `Needs Nick: this looks like a new Project${verdict.suggestedName ? ` ("${verdict.suggestedName}")` : ""}; agents never create Projects or Areas. ${clause(verdict.reason)}.`
          : verdict?.kind === "match" || verdict?.kind === "unsure"
            ? `Needs Nick: triage was not confident. Best guess: ${
                verdict.kind === "match" ? verdict.projectKey : (verdict.bestGuess ?? "none")
              }${verdict.kind === "match" && !match ? " (not a known Project or Area)" : ""}. ${clause(verdict.reason)}.`
            : "Needs Nick: triage found no matching Project or Area.";
      yield* entry("question", `${text}${duplicateNote}`);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("tickets.triage.failed", { cause })));

  const worker = yield* makeDrainableWorker(triage);
  /** Only `created` ids are triaged, so triage's own writes never loop. */
  const onChange = (change: Tickets.TicketChange) =>
    Effect.forEach(change.created, worker.enqueue, { discard: true });
  const start = Effect.gen(function* () {
    const subscription = yield* tickets.subscribeChanges;
    yield* PubSub.take(subscription).pipe(
      Effect.flatMap(onChange),
      Effect.forever,
      Effect.forkScoped,
    );
  });
  return { start, onChange, triage: worker.enqueue, drain: worker.drain };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* make;
    yield* worker.start;
  }),
);

const PREFIX = "Automatic ticket triage request from T3 Code:";
const line = (text: string) => text.replace(/\s+/g, " ").trim();

/** The self-contained instructions the triage agent receives. */
export function triagePrompt(input: TriageInput): string {
  const list = (items: ReadonlyArray<string>, empty: string) =>
    items.length ? items.join("\n") : empty;
  return [
    `${PREFIX} decide where a new Idea belongs. This is a record-keeping request; do not do the work itself, edit files or run commands.`,
    "",
    `Idea ${input.idea.id}: ${line(input.idea.title)}`,
    input.idea.body.trim() ? input.idea.body.trim().slice(0, 4000) : "(no description)",
    "",
    "Known Projects and Areas (key — name, area, current Goal):",
    list(
      input.candidates.map(
        (c) =>
          `- ${c.key} — ${line(c.name)}${c.area ? `, area ${c.area}` : ""}${c.goal ? `, goal: ${line(c.goal)}` : ""}`,
      ),
      "- (none registered)",
    ),
    "",
    "Open tickets (check for duplicates):",
    list(
      input.openTickets
        .slice(0, 100)
        .map((t) => `- ${t.readableId ?? t.id} [${t.projectKey ?? "inbox"}] ${line(t.title)}`),
      "- (none)",
    ),
    "",
    "Rules:",
    "1. Never create a Project or an Area. Only use a key from the list above.",
    `2. If you are confident the Idea belongs to exactly one listed key and is not a duplicate, call t3_ticket_update with id ${input.idea.id}, that projectKey and status "ready", then t3_ticket_entry kind "decision" saying why.`,
    `3. Otherwise (it looks like a new Project, you are unsure, or it duplicates an open ticket) leave it in the inbox and call t3_ticket_entry kind "question" with text starting "Needs Nick:" and your best guess, reason and any duplicate ticket ID.`,
    "4. Stop after the entry.",
  ].join("\n");
}

/**
 * Hands the Idea to a short agent thread in the scratch project, using the
 * utility text-generation model. The agent records its decision through the
 * ticket MCP tools. The command id is derived from the ticket, so a retry
 * never launches a second thread.
 */
export const layerAgentClassifier = Layer.effect(
  TicketTriageClassifier,
  Effect.gen(function* () {
    const launcher = yield* ThreadLaunch.ThreadLaunchService;
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const settings = yield* Settings.ServerSettingsService;
    return TicketTriageClassifier.of({
      classify: (input) =>
        Effect.gen(function* () {
          const current = yield* settings.getSettings;
          const { projectId } = yield* folders.ensureScratchProject;
          const title = line(input.idea.title);
          const launched = yield* launcher.launch({
            commandId: CommandId.make(`ticket-triage:${input.idea.id}`),
            projectId,
            title: `Triage: ${title.length > 60 ? `${title.slice(0, 59)}…` : title}`,
            modelSelection: current.textGenerationModelSelection,
            runtimeMode: current.defaultRuntimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { text: triagePrompt(input), attachments: [] },
            createdBy: "system",
            creationSource: "server",
          });
          return { kind: "delegated", threadId: launched.threadId } as const;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("tickets.triage.agent-failed", { cause }).pipe(Effect.as(null)),
          ),
        ),
    });
  }),
);
