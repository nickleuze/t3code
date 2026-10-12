# Ticket sync decisions

Tickets outlive a thread and may be edited on disconnected machines. Sync uses
[append-only event files in Git](../../apps/server/src/tickets/TicketSyncService.ts)
rather than a mutable ticket file: each event has a unique filename incorporating
its machine identity. Independent event writes do not compete for a path, so their
merge has no file conflicts by construction. Concurrent edits still need a winner;
the [projection](../../apps/server/src/tickets/TicketRecord.ts) applies deterministic
event ordering, which assumes reasonably synchronized clocks. Shared project
registry edits are mutable and can conflict; preserve the clone for manual
resolution rather than overwriting it.

The SQLite record and reference index are disposable projections, not the shared
source of truth. [TicketService](../../apps/server/src/tickets/TicketService.ts)
writes event files before projecting them, so a failed projection can be recovered
by reimport and rebuild. Do not repair a ticket by editing its projected row: the
next rebuild will discard that edit. Local project paths and mappings stay local.

A stage advances automatically only on a witnessed transition. Linking an old
thread, importing files, rebuilding, or seeing an old goal's history must not imply
that work just started. Only current work can advance on its non-draft PR link or
merge; an agent result requires human acceptance. This protects deliberate stage
changes from stale history and distinguishes a finished turn from finished work.

The [observation](../../apps/server/src/tickets/TicketObservations.ts) and
[handoff-nudge](../../apps/server/src/tickets/TicketHandoffNudge.ts) workers read the
committed EventSink after its latest sequence at startup. They never replay prior
orchestration events. Reconciliation snapshots establish baselines, not activity;
changing these workers to replay history would manufacture transitions or dispatch
new agent work from an old completed turn. The nudge also checks RuntimePolicy:
record-keeping must not turn read-only work into an automatic write request.
