import { readmeFrontmatter } from "../project/ProjectHome.ts";
/**
 * Triage: decides what a new Idea becomes as soon as it is created.
 *
 * Classifies only `created` changes for key-less inbox tickets created on this
 * machine; later changes repair an omitted decision without reclassifying.
 * A deterministic pre-pass files Ideas that name exactly one known Project
 * or Area; anything else goes to the pluggable classifier. Confident matches
 * get a project key, status ready and a decision entry. New Projects and
 * unsure cases stay in the Inbox with a "Needs Nick" question entry. Agents
 * never create Projects or Areas: a verdict naming an unknown key is treated
 * as a best guess.
 *
 * @module TicketTriage
 */
import { CommandId, type ProjectId, type ThreadId, type TicketId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
    const registered = yield* projects.list();
    const found = new Map<string, TriageCandidate>();
    const homes = new Set<string>();
    const roots = new Set<string>();
    const metadata = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map(readmeFrontmatter),
        Effect.orElseSucceed(() => ({}) as ReturnType<typeof readmeFrontmatter>),
      );
    const addHome = Effect.fnUntraced(function* (
      home: string,
      projectId: ProjectId | null,
      area?: string,
    ) {
      if (homes.has(home)) return;
      homes.add(home);
      const meta = yield* metadata(path.join(home, "README.md"));
      if (
        !meta.id ||
        !/^[a-z0-9][a-z0-9-]*$/.test(meta.id) ||
        !meta.area ||
        meta.area_repo === "true" ||
        (area && meta.area !== area) ||
        !(yield* fs.exists(path.join(home, ".git")))
      )
        return;
      const mapped = known.find((p) => projectId !== null && p.projectId === projectId);
      const key = mapped?.key ?? meta.id;
      const existing = known.find((p) => p.key === key);
      if (found.has(key) || (existing?.projectId && existing.projectId !== projectId)) return;
      found.set(key, {
        key,
        name: meta.id,
        area: meta.area,
        ...(meta.goal ? { goal: meta.goal } : {}),
      });
      if (!existing || (projectId !== null && existing.projectId === null))
        yield* tickets.projectsMap({ key, projectId, displayName: meta.id });
      const parent = path.dirname(home);
      if ((yield* metadata(path.join(parent, "AREA.md"))).area === meta.area)
        roots.add(path.dirname(parent));
    });
    for (const project of registered) yield* addHome(project.workspaceRoot, project.projectId);
    // Bounded discovery: Area folders and their immediate Homes, including Homes
    // Nick has not registered in T3. Register Ticket keys, never create Projects.
    for (const root of roots) {
      for (const name of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
        if (name.startsWith(".") || name === "_archive") continue;
        const folder = path.join(root, name);
        const meta = yield* metadata(path.join(folder, "AREA.md"));
        if (meta.area !== name) continue;
        if (!found.has(name)) {
          found.set(name, { key: name, name });
          if (!known.some((p) => p.key === name))
            yield* tickets.projectsMap({ key: name, projectId: null });
        }
        for (const child of yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []))) {
          if (child.startsWith(".")) continue;
          const home = path.join(folder, child);
          yield* addHome(
            home,
            registered.find((p) => p.workspaceRoot === home)?.projectId ?? null,
            name,
          );
        }
      }
    }
    return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
  });

  const completeAgentMatch = Effect.fnUntraced(function* (id: TicketId) {
    if (!(yield* settings.getSettings).ticketTriage) return;
    const state = yield* tickets.get(id).pipe(Effect.orElseSucceed(() => null));
    if (!state) return;
    const { ticket } = state;
    if (!ticket.projectKey || ticket.status !== "ready" || ticket.deletedAt !== null) return;
    const { events } = yield* tickets.timeline({ id });
    const created = events.find((e) => e.type === "created");
    if (created?.by.machine !== machine || created.projectKey !== null) return;
    const assignment = events.findLast(
      (e) => e.type === "fields" && e.projectKey === ticket.projectKey,
    );
    if (!assignment || assignment.by.actor !== "agent" || !assignment.by.thread) return;
    if (
      events.some(
        (e) => e.type === "entry" && e.kind === "decision" && e.by.thread === assignment.by.thread,
      )
    )
      return;
    yield* tickets.entry(
      {
        id,
        kind: "decision",
        clientRequestId: `triage-agent-match:${id}`,
        text: `Triage: filed under ${ticket.projectName ?? ticket.projectKey} (${ticket.projectKey}) by the agent classifier.`,
      },
      by,
      "triage",
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
  /** Classify only new Ideas; later changes repair an omitted agent decision. */
  const onChange = (change: Tickets.TicketChange) =>
    Effect.gen(function* () {
      yield* Effect.forEach(change.created, worker.enqueue, { discard: true });
      yield* Effect.forEach(
        change.ids.filter((id) => !change.created.includes(id)),
        completeAgentMatch,
        { discard: true },
      );
    });
  const start = Effect.gen(function* () {
    const subscription = yield* tickets.subscribeChanges;
    yield* Effect.forEach((yield* tickets.list()).tickets, (t) => completeAgentMatch(t.id), {
      discard: true,
    });
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
    `2. If you are confident the Idea belongs to exactly one listed key and is not a duplicate, first call t3_ticket_entry kind "decision" saying why, then t3_ticket_update with id ${input.idea.id}, that projectKey and status "ready".`,
    `3. Otherwise (it looks like a new Project, you are unsure, or it duplicates an open ticket) leave it in the inbox and call t3_ticket_entry kind "question" with text starting "Needs Nick:" and your best guess, reason and any duplicate ticket ID.`,
    "4. Stop after recording the verdict; do not do the Ticket's work.",
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
