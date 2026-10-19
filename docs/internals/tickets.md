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
that work just started. Current work's non-draft PR links and merges can move
active work to In review. A supporting PR may merge before the Ticket's finish
condition is met, so completion requires explicit acceptance. Historical stage
events retain their recorded meaning, including older merge-driven Done events;
import and rebuild never reinterpret them. This protects deliberate stage changes
from stale history and distinguishes a finished turn from finished work.

The [observation](../../apps/server/src/tickets/TicketObservations.ts) and
[handoff-nudge](../../apps/server/src/tickets/TicketHandoffNudge.ts) workers read the
committed EventSink after its latest sequence at startup. They never replay prior
orchestration events. Reconciliation snapshots establish baselines, not activity;
changing these workers to replay history would manufacture transitions or dispatch
new agent work from an old completed turn. The nudge also checks RuntimePolicy:
record-keeping must not turn read-only work into an automatic write request.

Planning outcomes are different from write nudges: the server records only source
pointers and the terminal Run outcome, without dispatching a provider or changing
stage/permissions. [TicketPlanOutcome](../../apps/server/src/tickets/TicketPlanOutcome.ts)
initializes a local cursor at the latest sequence on first activation, then recovers
only subsequent missed events, including restart interruptions. Advance it after
all linked-ticket writes; per-run/per-ticket entry keys handle a crash after a
write. Both entry time and ID use the source completion time so delayed delivery
cannot cross a newer acceptance/reopen boundary or overwrite later evidence.
The automatic note leaves blockers and authored next actions intact; a current
handoff remains in the launch Brief beside the source note. No prior history is
backfilled, and the cursor is delivery state, not part of Ticket sync/rebuild.

## Launch decisions

[TicketLaunchService](../../apps/server/src/tickets/TicketLaunchService.ts) owns
launch decisions for RPC, MCP and the web. A plan-first launch is linked as `work`:
planning belongs to the work thread and its activity must be visible on the ticket.
A local work link with a running turn, pending request, actionable plan or active /
needs-input goal returns `already_active` unless parallel work is explicitly
allowed. Another machine's link does not block a local launch.

The caller's thread and command IDs are the retry identity. Preserve them after an
ambiguous failure; use fresh IDs for a different launch mode or destination. The
accepted receipt and thread settings govern retries even if project defaults or
mappings change. MCP derives those IDs from the caller-scoped `clientRequestId`.

Launch settings come only from project defaults and the shared model fallback
resolver, never remembered per-ticket web selections. An unset workspace defaults
to a HEAD worktree for repositories with a commit; non-Git folders and repositories
without HEAD launch at the project root. Explicit local mode also uses the root.
This fallback is ticket-specific so tickets can start non-coding work.

Cross-machine launches resolve project mappings and defaults on the destination.
A missing ticket triggers one sync refresh and one retry with the same IDs; a
missing project asks for a project from that destination. Capture commits creation
before launch, so a launch failure must preserve the new ticket and offer Retry.
