import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { formatModelSlugName } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { deriveTicketWorkState } from "@t3tools/shared/ticket";
import type { TicketEvent, TicketEntryInput } from "@t3tools/contracts";
import {
  TICKET_STATUS_LABELS,
  type EnvironmentTicket,
} from "@t3tools/client-runtime/state/ticket-board";
import { observeResize } from "../../lib/observeResize";
import { ticketEnvironment, useTicketWriteAllowed } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";
import { TicketPicker } from "./TicketPicker";
import { ticketTimelineLabel } from "./ticketRecord.logic";
import { TicketRecordLinks } from "./TicketLinks";

type Entry = Extract<TicketEvent, { type: "entry" }>;
export function TicketTimeline({
  entry,
  composerRef,
}: {
  entry: EnvironmentTicket;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { environmentId, ticket } = entry;
  const query = useMemo(
    () => ticketEnvironment.timeline({ environmentId, input: { id: ticket.id } }),
    [environmentId, ticket.id],
  );
  const result = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  useEffect(() => {
    if (ticket.updatedAt) refresh();
  }, [refresh, ticket.updatedAt]);
  const allowed = useTicketWriteAllowed(environmentId);
  const add = useAtomCommand(ticketEnvironment.addEntry);
  const narrow = useMediaQuery("(max-width: 480px)");
  const [kind, setKind] = useState<TicketEntryInput["kind"]>("note");
  const [text, setText] = useState("");
  const [next, setNext] = useState("");
  const [supersedes, setSupersedes] = useState<string | null>(null);
  const [resolving, setResolving] = useState<Entry | null>(null);
  const [resolution, setResolution] = useState<"answer" | "dismiss">("answer");
  const hasDraft = !!text.trim() || !!next.trim();
  const [request, setRequest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "entries" | "auto">("entries");
  const [visibleCount, setVisibleCount] = useState(10);
  const [history, setHistory] = useState(false);
  const events = AsyncResult.isSuccess(result) ? result.value.events : [];
  const machines = AsyncResult.isSuccess(result) ? result.value.machines : {};
  const view = useMemo(() => deriveTicketWorkState(events, ticket.status), [events, ticket.status]);
  const { entries, superseded, resolved, questions, blockers, currentEvidence, nextAction } = view;
  const decisions = (
    history ? entries.filter((e) => e.kind === "decision") : view.decisions
  ).toReversed();
  const timeline = events
    .toSorted((a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId))
    .filter(
      (e) => filter === "all" || (filter === "entries" ? e.type === "entry" : e.type === "auto"),
    )
    .toReversed();
  const stageEvent = events.findLast(
    (e) => e.type === "stage" && e.stage === ticket.status && e.at === ticket.statusSetAt,
  );
  const focusComposer = () => {
    composerRef.current?.scrollIntoView({ block: "center" });
    composerRef.current?.focus({ preventScroll: true });
  };
  const submit = async (input: TicketEntryInput) => {
    setBusy(true);
    setError(null);
    try {
      const result = await add({ environmentId, input });
      if (result._tag === "Success") {
        refresh();
        return true;
      }
      setError("Could not record entry. Your text is kept.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const author = (event: Pick<TicketEvent, "by">) =>
    `${event.by.model ? formatModelSlugName(event.by.model).replace(/^Claude /, "") : event.by.actor === "user" ? "Nick" : "Agent"} on ${machines[event.by.machine] ?? event.by.machine}${event.by.thread ? `, in ${events.filter((e): e is Extract<TicketEvent, { type: "link" | "unlink" }> => e.type === "link" || e.type === "unlink").findLast((e) => e.kind === "thread" && e.ref === event.by.thread && e.machine === event.by.machine)?.title ?? event.by.thread}` : ""}`;
  return (
    <div className="grid gap-6">
      <section aria-label="Current evidence" className="grid gap-3">
        <h3 className="font-medium">Current evidence</h3>
        <p className="text-xs text-muted-foreground">
          Stage: {TICKET_STATUS_LABELS[ticket.status]} ·{" "}
          {new Date(ticket.statusSetAt).toLocaleString()}
          {stageEvent ? ` · ${author(stageEvent)}` : ""}
        </p>
        {!AsyncResult.isSuccess(result) ? (
          <p>
            {AsyncResult.isFailure(result)
              ? "Could not load current evidence."
              : "Loading current evidence…"}
          </p>
        ) : currentEvidence ? (
          <article className="grid gap-2 text-sm">
            <h4 className="font-medium">{ticketTimelineLabel(currentEvidence, machines)}</h4>
            <EntryText key={currentEvidence.eventId} text={currentEvidence.text} />
            <p className="text-xs text-muted-foreground wrap-anywhere">
              {author(currentEvidence)} · {new Date(currentEvidence.at).toLocaleString()}
            </p>
            <h4 className="font-medium">Next action</h4>
            <p className="whitespace-pre-wrap wrap-anywhere">
              {nextAction?.text || "No next action recorded in the latest work update."}
            </p>
            {nextAction ? (
              <p className="text-xs text-muted-foreground wrap-anywhere">
                Next recorded by {author(nextAction)} · {new Date(nextAction.at).toLocaleString()}
              </p>
            ) : null}
          </article>
        ) : (
          <p className="text-sm text-muted-foreground">
            {ticket.status === "done" || ticket.status === "dropped"
              ? "This Ticket is closed. Previous next actions remain in history."
              : "No current update or next action recorded. Previous entries remain in history."}
          </p>
        )}
      </section>
      <section aria-label="Brief" className="grid gap-2">
        <h3 className="font-medium">Brief · current scope and finish condition</h3>
        <p className="text-sm whitespace-pre-wrap wrap-anywhere">
          {ticket.body.trim() ||
            "No brief recorded. Add the scope and finish condition in Edit ticket."}
        </p>
        {view.briefSource ? (
          <p className="text-xs text-muted-foreground wrap-anywhere">
            Brief recorded by {author(view.briefSource)} ·{" "}
            {new Date(view.briefSource.at).toLocaleString()}
          </p>
        ) : null}
        {view.decisions.length ? (
          <a href="#ticket-decisions" className="text-sm underline">
            Review {view.decisions.length} current decisions and corrections
          </a>
        ) : null}
      </section>
      <section aria-label="Open questions and blockers" className="grid gap-3">
        {questions.length ? <h4 className="text-sm font-medium">Open questions</h4> : null}
        {questions.map((e) => (
          <article key={e.eventId} className="grid gap-1 text-sm">
            <p className="whitespace-pre-wrap wrap-anywhere">{e.text}</p>
            <p className="text-xs text-muted-foreground wrap-anywhere">
              {author(e)} · {new Date(e.at).toLocaleString()}
            </p>
            <Button
              size={narrow ? "touch" : "xs"}
              variant="outline"
              disabled={busy || !allowed || hasDraft}
              title={hasDraft ? "Finish or clear your draft entry first" : undefined}
              onClick={() => {
                setResolving(e);
                setNext("");
                setResolution("answer");
                setSupersedes(null);
                setKind("note");
                setText("");
                setRequest(null);
                focusComposer();
              }}
            >
              Answer or dismiss
            </Button>
          </article>
        ))}
        {blockers.map((e) => (
          <article key={e.eventId} className="grid gap-1 text-sm">
            <h4 className="font-medium">Blocked</h4>
            <p className="whitespace-pre-wrap wrap-anywhere">{e.text}</p>
            <p className="text-xs text-muted-foreground wrap-anywhere">
              {author(e)} · {new Date(e.at).toLocaleString()}
            </p>
            <Button
              size={narrow ? "touch" : "xs"}
              variant="outline"
              disabled={busy || !allowed || hasDraft}
              title={hasDraft ? "Finish or clear your draft entry first" : undefined}
              onClick={() => {
                setResolving(e);
                setResolution("answer");
                setSupersedes(null);
                setKind("note");
                setRequest(null);
                focusComposer();
              }}
            >
              Resolve blocker
            </Button>
          </article>
        ))}
      </section>
      <section aria-label="Entry composer" id="ticket-entry-composer" className="grid gap-3">
        <h3 className="font-medium">Add an entry</h3>
        {supersedes ? (
          <div className="flex items-center gap-2">
            <p className="text-sm">Superseding a decision</p>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSupersedes(null);
                setRequest(null);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : null}
        {resolving ? (
          <div className="grid gap-2">
            <p className="text-sm whitespace-pre-wrap wrap-anywhere">
              {resolving.kind === "blocker" ? "Blocker" : "Question"}: {resolving.text}
            </p>
            <TicketPicker
              label="Resolution"
              value={resolution}
              options={[
                { value: "answer", label: resolving.kind === "blocker" ? "Resolved" : "Answer" },
                { value: "dismiss", label: "Dismiss with reason" },
              ]}
              disabled={busy || !allowed}
              onChange={(value) => {
                setResolution(value as typeof resolution);
                setRequest(null);
              }}
            />
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                setResolving(null);
                setRequest(null);
              }}
            >
              Cancel resolution
            </Button>
          </div>
        ) : null}
        <TicketPicker
          label="Entry type"
          value={kind}
          onChange={(value) => {
            setKind(value as typeof kind);
            setSupersedes(null);
            setRequest(null);
          }}
          options={[
            { value: "note", label: "Note" },
            { value: "decision", label: "Decision" },
            { value: "question", label: "Question" },
            { value: "handoff", label: "Handoff" },
            { value: "progress", label: "Progress" },
            { value: "blocker", label: "Blocker" },
            { value: "result", label: "Result" },
          ]}
          disabled={busy || !allowed || resolving !== null}
        />
        <Textarea
          ref={composerRef}
          aria-label={
            resolving
              ? resolution === "answer"
                ? resolving.kind === "blocker"
                  ? "Blocker resolution"
                  : "Question answer"
                : "Dismissal reason"
              : "Ticket entry"
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setRequest(null);
          }}
          disabled={busy || !allowed}
        />
        {!resolving ? (
          <Input
            aria-label="Next action"
            placeholder="Next action (optional)"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setRequest(null);
            }}
            disabled={busy || !allowed}
          />
        ) : null}
        <Button
          size={narrow ? "touch" : "sm"}
          disabled={busy || !allowed || !text.trim()}
          onClick={() => {
            const clientRequestId = request ?? randomUUID();
            setRequest(clientRequestId);
            void submit({
              id: ticket.id,
              kind,
              text: resolving
                ? `${resolution === "answer" ? (resolving.kind === "blocker" ? "Resolved" : "Answer") : "Dismissed"}: ${text.trim()}`
                : text.trim(),
              clientRequestId,
              ...(supersedes ? { supersedes } : {}),
              ...(resolving ? { resolves: resolving.eventId } : {}),
              ...(!resolving && next.trim() ? { next: next.trim() } : {}),
            }).then((ok) => {
              if (ok) {
                setText("");
                setNext("");
                setSupersedes(null);
                setResolving(null);
                setRequest(null);
              }
            });
          }}
        >
          {resolving ? "Record resolution" : "Add entry"}
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </section>
      <section aria-label="Decisions" id="ticket-decisions" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">Decisions</h3>
          <Button
            size={narrow ? "touch" : "xs"}
            variant="ghost"
            onClick={() => setHistory(!history)}
          >
            {history ? "Current decisions" : "Show history"}
          </Button>
        </div>
        {decisions.length ? (
          decisions.map((e) => (
            <article key={e.eventId} className="grid gap-1 text-sm">
              <p className="whitespace-pre-wrap wrap-anywhere">{e.text}</p>
              <p className="text-xs text-muted-foreground">
                {author(e)} · {new Date(e.at).toLocaleString()}
                {superseded.has(e.eventId) ? " · Superseded" : ""}
              </p>
              {!superseded.has(e.eventId) ? (
                <Button
                  size={narrow ? "touch" : "xs"}
                  variant="outline"
                  disabled={busy || !allowed || hasDraft}
                  title={hasDraft ? "Finish or clear your draft entry first" : undefined}
                  onClick={() => {
                    setKind("decision");
                    setSupersedes(e.eventId);
                    setNext("");
                    setResolving(null);
                    setText("");
                    setRequest(null);
                    focusComposer();
                  }}
                >
                  Supersede
                </Button>
              ) : null}
            </article>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">No decisions recorded.</p>
        )}
      </section>
      <section aria-label="Ticket timeline" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">Recent entries and history</h3>
          <div className="flex gap-1">
            {["entries", "auto", "all"].map((value) => (
              <Button
                key={value}
                size={narrow ? "touch" : "xs"}
                variant={filter === value ? "secondary" : "ghost"}
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value as typeof filter);
                  setVisibleCount(10);
                }}
              >
                {value === "entries" ? "Entries" : value === "auto" ? "Auto" : "All"}
              </Button>
            ))}
          </div>
        </div>
        {AsyncResult.isSuccess(result) ? (
          timeline.slice(0, visibleCount).map((event) => (
            <article key={event.eventId} className="grid gap-1 border-l pl-3 text-sm">
              <h4 className="font-medium wrap-anywhere">{ticketTimelineLabel(event, machines)}</h4>
              {event.type === "entry" ? (
                <>
                  <p className="whitespace-pre-wrap wrap-anywhere">{event.text}</p>
                  {event.next ? (
                    <p className="whitespace-pre-wrap wrap-anywhere">Recorded next: {event.next}</p>
                  ) : null}
                  {event.resolves ? (
                    <p className="text-xs text-muted-foreground">
                      Resolves:{" "}
                      {entries.find((e) => e.eventId === event.resolves)?.text ?? event.resolves}
                    </p>
                  ) : null}
                  {event.supersedes ? (
                    <p className="text-xs text-muted-foreground">
                      Supersedes:{" "}
                      {entries.find((e) => e.eventId === event.supersedes)?.text ??
                        event.supersedes}
                    </p>
                  ) : null}
                  {resolved.has(event.eventId) || superseded.has(event.eventId) ? (
                    <p className="text-xs text-muted-foreground">
                      {resolved.has(event.eventId) ? "Resolved" : "Superseded"}
                    </p>
                  ) : null}
                </>
              ) : null}
              {event.type === "fields" || event.type === "created" ? (
                <>
                  {event.title !== undefined ? (
                    <p className="whitespace-pre-wrap wrap-anywhere">
                      Recorded title: {event.title}
                    </p>
                  ) : null}
                  {event.body !== undefined ? (
                    <EntryText text={`Recorded brief:\n${event.body || "(empty)"}`} />
                  ) : null}
                </>
              ) : null}
              <p className="text-xs text-muted-foreground wrap-anywhere">
                {author(event)} · {new Date(event.at).toLocaleString()}
              </p>
            </article>
          ))
        ) : (
          <p>{AsyncResult.isFailure(result) ? "Could not load timeline." : "Loading timeline…"}</p>
        )}
        {AsyncResult.isSuccess(result) && timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matching entries.</p>
        ) : null}
        {timeline.length > visibleCount ? (
          <Button
            variant="outline"
            size={narrow ? "touch" : "sm"}
            onClick={() => setVisibleCount((count) => count + 20)}
          >
            Show older ({timeline.length - visibleCount} remaining)
          </Button>
        ) : null}
      </section>
      <section aria-label="Links" className="grid gap-3">
        <h3 className="font-medium">Links</h3>
        <TicketRecordLinks entry={entry} events={events} machines={machines} />
      </section>
    </div>
  );
}

function EntryText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [expandable, setExpandable] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => setExpandable(node.scrollHeight > node.clientHeight);
    measure();
    return observeResize(node, measure);
  }, [expanded]);
  return (
    <div className="grid gap-1">
      <p
        ref={textRef}
        className={`whitespace-pre-wrap wrap-anywhere ${expanded ? "" : "line-clamp-4"}`}
      >
        {text}
      </p>
      {expandable ? (
        <div>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Read full entry"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
