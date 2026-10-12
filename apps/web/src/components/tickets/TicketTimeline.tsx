import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { formatModelSlugName } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";
import type { TicketEvent, TicketEntryInput } from "@t3tools/contracts";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
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
export function TicketTimeline({ entry }: { entry: EnvironmentTicket }) {
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
  const [kind, setKind] = useState<"note" | "decision" | "question" | "handoff">("note");
  const [text, setText] = useState("");
  const [next, setNext] = useState("");
  const [supersedes, setSupersedes] = useState<string | null>(null);
  const [request, setRequest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "entries" | "auto">("all");
  const [history, setHistory] = useState(false);
  const events = AsyncResult.isSuccess(result) ? result.value.events : [];
  const machines = AsyncResult.isSuccess(result) ? result.value.machines : {};
  const entries = events.filter((e): e is Entry => e.type === "entry");
  const superseded = new Set(entries.flatMap((e) => e.supersedes ?? []));
  const resolved = new Set(entries.flatMap((e) => e.resolves ?? []));
  const decisions = entries.filter(
    (e) => e.kind === "decision" && (history || !superseded.has(e.eventId)),
  );
  const questions = entries.filter((e) => e.kind === "question" && !resolved.has(e.eventId));
  const lastHandoff = entries.findLast((e) => e.kind === "handoff");
  const blockers = [
    ...new Map(
      entries
        .filter((e) => ["blocker", "progress", "result", "handoff"].includes(e.kind))
        .map((e) => [e.by.thread ?? e.by.machine, e]),
    ).values(),
  ].filter((e) => e.kind === "blocker");
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
  const author = (event: TicketEvent) =>
    `${event.by.model ? formatModelSlugName(event.by.model).replace(/^Claude /, "") : event.by.actor === "user" ? "Nick" : "Agent"} on ${machines[event.by.machine] ?? event.by.machine}${event.by.thread ? `, in ${events.filter((e): e is Extract<TicketEvent, { type: "link" | "unlink" }> => e.type === "link" || e.type === "unlink").findLast((e) => e.kind === "thread" && e.ref === event.by.thread && e.machine === event.by.machine)?.title ?? event.by.thread}` : ""}`;
  return (
    <div className="grid gap-6">
      <section aria-label="Now" className="grid gap-3">
        <h3 className="font-medium">Now</h3>
        {lastHandoff ? (
          <article className="grid gap-1 text-sm">
            <p className="whitespace-pre-wrap wrap-anywhere">{lastHandoff.text}</p>
            {lastHandoff.next ? (
              <p className="whitespace-pre-wrap">Next: {lastHandoff.next}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{author(lastHandoff)}</p>
          </article>
        ) : (
          <p className="text-sm text-muted-foreground">No handoff yet.</p>
        )}
        {questions.length ? <h4 className="text-sm font-medium">Open questions</h4> : null}
        {questions.map((e) => (
          <article key={e.eventId} className="grid gap-1 text-sm">
            <p className="whitespace-pre-wrap wrap-anywhere">{e.text}</p>
            <Button
              size={narrow ? "touch" : "xs"}
              variant="outline"
              disabled={busy || !allowed}
              onClick={() =>
                void submit({
                  id: ticket.id,
                  kind: "note",
                  text: `Resolved: ${e.text}`,
                  resolves: e.eventId,
                  clientRequestId: `resolve:${e.eventId}`,
                })
              }
            >
              Resolve question
            </Button>
          </article>
        ))}
        {blockers.map((e) => (
          <article key={e.eventId} className="grid gap-1 text-sm">
            <h4 className="font-medium">Blocked</h4>
            <p className="whitespace-pre-wrap wrap-anywhere">{e.text}</p>
          </article>
        ))}
      </section>
      <section aria-label="Decisions" className="grid gap-3">
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
                {author(e)}
                {superseded.has(e.eventId) ? " · Superseded" : ""}
              </p>
              {!superseded.has(e.eventId) ? (
                <Button
                  size={narrow ? "touch" : "xs"}
                  variant="outline"
                  disabled={busy || !allowed}
                  onClick={() => {
                    setKind("decision");
                    setSupersedes(e.eventId);
                    setText("");
                    setRequest(null);
                    document
                      .getElementById("ticket-entry-composer")
                      ?.scrollIntoView({ block: "center" });
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
          <h3 className="font-medium">Timeline</h3>
          <div className="flex gap-1">
            {["entries", "auto", "all"].map((value) => (
              <Button
                key={value}
                size={narrow ? "touch" : "xs"}
                variant={filter === value ? "secondary" : "ghost"}
                aria-pressed={filter === value}
                onClick={() => setFilter(value as typeof filter)}
              >
                {value === "entries" ? "Entries" : value === "auto" ? "Auto" : "All"}
              </Button>
            ))}
          </div>
        </div>
        {AsyncResult.isSuccess(result) ? (
          events
            .filter(
              (e) =>
                filter === "all" || (filter === "entries" ? e.type === "entry" : e.type === "auto"),
            )
            .map((event) => (
              <article key={event.eventId} className="grid gap-1 border-l pl-3 text-sm">
                <h4 className="font-medium wrap-anywhere">
                  {ticketTimelineLabel(event, machines)}
                </h4>
                {event.type === "entry" ? (
                  <>
                    <p className="whitespace-pre-wrap wrap-anywhere">{event.text}</p>
                    {event.next ? <p className="whitespace-pre-wrap">Next: {event.next}</p> : null}
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
      </section>
      <section aria-label="Links" className="grid gap-3">
        <h3 className="font-medium">Links</h3>
        <TicketRecordLinks entry={entry} events={events} machines={machines} />
      </section>
      <section aria-label="Entry composer" id="ticket-entry-composer" className="grid gap-3">
        <h3 className="font-medium">Add an entry</h3>
        {supersedes ? (
          <div className="flex items-center gap-2">
            <p className="text-sm">Superseding a decision</p>
            <Button size="xs" variant="ghost" onClick={() => setSupersedes(null)}>
              Cancel
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
          ]}
          disabled={busy || !allowed}
        />
        <Textarea
          aria-label="Ticket entry"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setRequest(null);
          }}
          disabled={busy || !allowed}
        />
        {kind === "handoff" ? (
          <Input
            aria-label="Next step"
            placeholder="Next:"
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
              text: text.trim(),
              clientRequestId,
              ...(supersedes ? { supersedes } : {}),
              ...(kind === "handoff" ? { next } : {}),
            }).then((ok) => {
              if (ok) {
                setText("");
                setNext("");
                setSupersedes(null);
                setRequest(null);
              }
            });
          }}
        >
          Add entry
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
