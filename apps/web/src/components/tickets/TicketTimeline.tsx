import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { formatModelSlugName } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";
import type { EnvironmentTicket } from "@t3tools/client-runtime/state/ticket-board";
import { ticketEnvironment, useTicketWriteAllowed } from "../../state/tickets";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { TicketPicker } from "./TicketPicker";

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
  const canWrite = useTicketWriteAllowed(environmentId);
  const add = useAtomCommand(ticketEnvironment.addEntry);
  const [kind, setKind] = useState<"note" | "decision" | "question">("note");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="Ticket timeline" className="grid gap-3">
      <h3 className="text-sm font-medium">Timeline</h3>
      {AsyncResult.isSuccess(result) ? (
        result.value.events.map((event) => (
          <article key={event.eventId} className="grid gap-1 border-l pl-3 text-sm">
            <div className="font-medium">
              {"kind" in event
                ? event.kind.replaceAll("_", " ")
                : event.type === "stage"
                  ? event.stage.replaceAll("_", " ")
                  : event.type}
            </div>
            {event.type === "entry" ? (
              <>
                <p className="whitespace-pre-wrap">{event.text}</p>
                {event.next ? <p>Next: {event.next}</p> : null}
              </>
            ) : event.type === "auto" ? (
              <p>{event.ref}</p>
            ) : null}
            <div className="text-xs text-muted-foreground">
              {event.by.model
                ? formatModelSlugName(event.by.model).replace(/^Claude /, "")
                : event.by.actor === "user"
                  ? "Nick"
                  : "Agent"}{" "}
              on {result.value.machines[event.by.machine] ?? event.by.machine}
              {event.by.thread ? `, in ${event.by.thread}` : ""} ·{" "}
              {new Date(event.at).toLocaleString()}
            </div>
          </article>
        ))
      ) : (
        <p>{AsyncResult.isFailure(result) ? "Could not load timeline." : "Loading timeline…"}</p>
      )}
      <TicketPicker
        label="Entry type"
        value={kind}
        onChange={(value) => setKind(value as typeof kind)}
        options={[
          { value: "note", label: "Note" },
          { value: "decision", label: "Decision" },
          { value: "question", label: "Question" },
        ]}
        disabled={busy || !canWrite}
      />
      <Textarea
        aria-label="Ticket entry"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={busy || !canWrite}
      />
      <Button
        size="sm"
        disabled={busy || !canWrite || !text.trim()}
        onClick={() => {
          setBusy(true);
          setError(null);
          void add({ environmentId, input: { id: ticket.id, kind, text: text.trim() } })
            .then((result) => {
              if (result._tag === "Success") {
                setText("");
                refresh();
              } else setError("Could not record entry. Your text is kept.");
            })
            .finally(() => setBusy(false));
        }}
      >
        Add entry
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
