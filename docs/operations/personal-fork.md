# Maintaining Nick's T3 fork

Keep personal preferences useful and the recurring upstream integration cost
small. This is the fork's maintenance procedure; upstream's architecture,
contribution rules and development runbook still apply.

## Upstream and acceptance

The official v2 development line was squash-merged into `pingdotgg/t3code`'s
`main` in [PR #2829](https://github.com/pingdotgg/t3code/pull/2829), at
`de343914273eceb852a1d1d739cd1d38df7796ee`. Track official `main`, rather than
the removed `t3code/codex-turn-mapping` branch.

The personal changes inventoried here start after the development baseline
`fa65ee6a7253ecf53645da26fc3af9a354e41b9e` and include the goal proposals added
at `3fcea63bea`. That baseline is in the final official v2 development history,
including its project-folder ownership changes. It is not an accepted official
`main` baseline: the squash merge did not preserve the development ancestry.
Resolve that history once by starting an isolated candidate from a pinned
official commit and porting the personal behavior still needed.

[fork/upstream-base](../../fork/upstream-base) records the last **accepted**
official commit. It is intentionally unset until the first integration passes
acceptance. Fetching, observing a commit or finding a merge base never advances
this record. Do not use an `ours` merge to declare upstream integrated.

## Feature work

For each idea, state the intended behavior, why existing settings/tools do not
satisfy it, acceptance examples, affected clients/providers, persisted-state
impact and upstream integration points. Keep this brief in the task or its
tracking issue; create a PR only when requested. Use Git and the merged PR as
the implementation history, rather than a second repository checklist.

Prefer existing settings and adapters. Add focused modules at existing seams,
with small caller changes, and preserve upstream names and structure. Avoid
unrelated formatting, dependency changes and architectural cleanup. A setting
or switch is useful when users need a choice or a feature needs safe rollout;
it is not required for every fix. Do not build a second plugin framework.

Changes to orchestration, shared contracts or persistence need an explicit
compatibility decision before implementation. Review event replay, older
clients, settings decoding and unsupported providers. Never rewrite an applied
migration; resolve fork/upstream migration collisions before shipping.

The main T3 session owns planning and acceptance. Use T3's native task tools and
live provider/model catalog for authorized delegation, with a defined workspace
and acceptance criteria. No separate orchestrator, fixed worker or Router is
required. Select a thread's workspace through T3 when launching a new ordinary
thread; a delegated child task and a top-level conversation are different work.

| Branch role    | Convention                             | Promotion rule                                                        |
| -------------- | -------------------------------------- | --------------------------------------------------------------------- |
| Feature        | `nick/feat/<idea>` in its own worktree | One coherent behavior, based on the integration line once established |
| Integration    | `nick/integration`                     | Combined candidate for validation; no automatic app publication       |
| Upstream sync  | `nick/sync/<date>`                     | Pinned official changes, reviewed separately from new features        |
| Release source | Existing `nick/v2`                     | Promote the exact accepted commit; pushes can publish an app          |

These conventions do not create branches or change protection settings. After
the first history alignment, use normal merges on shared branches. Rebase only
disposable feature work that nobody else depends on; preserve recovery branches.

## Personal maintenance inventory

The following groups cover the personal behavior after the development baseline.
Use their acceptance evidence whenever the relevant upstream integration points
change. Listed tests identify coverage to run, not proof of an installed build.
At a sync, keep the personal behavior, use an adequate upstream equivalent, or
retire it with a deliberate decision. Check inherited preview differences too;
do not reimplement the project-folder behavior already in official v2.

| Behavior to preserve                                                                                      | Upstream-sensitive integration points                                                                                                               | Acceptance evidence                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable `/t3-goal` loops, fresh iterations, pause/resume/stop and handoff                                 | [GoalLoopWorker](../../apps/server/src/orchestration-v2/GoalLoopWorker.ts), command/event contracts, projection and provider turn lifecycle         | `GoalState.test.ts`, `GoalLoopWorker.test.ts`, `GoalLoop.test.ts`; start/steer/stop, usage-limit recovery, restart/replay and no goal inheritance into ordinary subagents                                |
| Agent-drafted goal proposals that run only after the user starts them                                     | [GoalState](../../apps/server/src/orchestration-v2/GoalState.ts), MCP goal toolkit, ChatView/composer and goal banner                               | Goal proposal coverage in `GoalState.test.ts` and `GoalLoop.test.ts`, plus `goalPresentation.test.ts`; proposing starts no turn, dismissal is repeatable, Start creates exactly one goal                 |
| Goal replies/control channel, nested iteration rows, unfolding parked iterations and flat sidebar sorting | [Sidebar.logic](../../apps/web/src/components/Sidebar.logic.ts), client state and settings schemas                                                  | `Sidebar.logic.test.ts` and `packages/contracts/src/settings.test.ts`; persisted `last_activity`, goal/iteration visibility and selection, including stopped/parked goals                                |
| Launching ordinary threads from auto mode and receiving completion/waiting reports                        | [ThreadReportBack](../../apps/server/src/orchestration-v2/ThreadReportBack.ts), project/thread MCP handlers, launch authorization and notifications | `ThreadReportBack.test.ts`, project toolkit tests and `OrchestratorMcpToolkit.integration.test.ts`; correct workspace binding, bounded runtime permissions and one report to the initiating thread       |
| Cursor questions and T3 tools in supported permission modes                                               | [CursorT3Tools](../../apps/server/src/orchestration-v2/Adapters/CursorT3Tools.ts), Cursor adapter, MCP bridge and RPC authorization                 | `CursorT3Tools.test.ts` and `CursorAdapterV2.test.ts`; question/reply completion, restricted-mode tool availability and cancellation                                                                     |
| One fork release and coordinated updates, stable signing identity and T3 Connect configuration            | [Fork release workflow](../../.github/workflows/fork-release.yml), `fork/update*.sh`, signing, server update checks and sidebar update UI           | `ForkUpdate.test.ts`, update pill logic tests, built artifact inspection and installation/reconnect evidence on each Mac; same accepted commit/version, valid Connect configuration and signing identity |
| Desktop shutdown finishes and stalled shutdowns leave useful diagnostics                                  | [DesktopLifecycle](../../apps/desktop/src/app/DesktopLifecycle.ts), app/server teardown and updater handoff                                         | `DesktopLifecycle.test.ts` and a real quit/update pass after active turns finish; preserve in-flight work and verify relaunch/reconnection separately                                                    |

Full test paths and additional cases remain in the source. Goal and thread
changes also touch shared contracts and client runtime, so a server-only pass
does not establish compatibility with desktop/web/mobile or older clients.

## Checking official updates

Run from the repository, or invoke the script by its absolute path:

```bash
fork/upstream-check.sh
fork/upstream-check.sh --fork-ref nick/integration
fork/upstream-check.sh --offline
node --test fork/upstream-check.test.mjs
```

The normal check fetches only official `main`, pins the reported commit IDs and
compares committed refs. A failed fetch stops the check instead of using stale
data. `--offline` explicitly reports cached refs without a freshness claim.
Uncommitted edits are reported but are not part of the comparison.

Exit `0` means the report completed, not that a merge or release is safe. Exit
`2` means first integration/history alignment is required, including when the
selected fork or upstream history lacks the accepted commit. Exit `1` is an
operational/configuration error; `64` is invalid usage. Before first alignment,
the checker reports the current upstream SHA and the missing accepted baseline
without inventing an update count from incompatible histories.

After acceptance is established, the report shows new official commits, files
changed on both sides, and changed migration/contract/provider/lifecycle/build
paths. It includes edits and deletions, not just new migrations. File overlap is
only a review signal: a clean textual merge can still change behavior.

Check weekly and before core changes. This is an on-demand command; no scheduler
is installed. Each sync pins the fetched official SHA in the task, prepares an
isolated candidate, reviews changes by intent, and runs relevant acceptance.
Record the accepted SHA in `fork/upstream-base` only as part of that accepted
integration. It must be an ancestor of both the selected fork and official main.

## Integration and release acceptance

For the first integration, preserve the current fork commit/history and the
installed release. Start the candidate from the pinned official `main` commit;
port personal groups in dependency order, preferring upstream equivalents that
meet the same acceptance examples. Reconcile behavior against the inventory
before promoting the candidate. Later syncs merge the pinned upstream commit
into a dedicated sync branch based on the integration line.

Use focused behavioral tests, lint and type checks for affected code. Follow
[AGENTS.md](../../AGENTS.md#verifying): full-suite checks belong to CI. The
checker itself is covered with temporary Git repositories, including stale
fetch failures and invalid history, without provider calls or app restarts.

For core changes, validate a consistent copy of real SQLite state and settings
in the candidate's isolated home: startup, migration/replay, restart/reconnect
and the relevant personal behavior. Take SQLite snapshots consistently; do not
copy a live database as ordinary files or point a candidate at live state.
Credentials stay host-local and copies of private state stay out of Git.
Decide applicability for web/desktop/mobile, providers, permissions and
local/remote/Connect modes. Capture a real-client acceptance pass for visible
changes when authorized.

The fork's [CI workflow](../../.github/workflows/fork-ci.yml) runs the full
upstream checks on GitHub-hosted runners, including candidate branches, and is
reusable by the [release workflow](../../.github/workflows/fork-release.yml).
Only `nick/v2` can publish, including manual dispatch. Release checks always run
for the exact triggering SHA. Their aggregate rejects failed, cancelled, missing
or accidentally skipped jobs and emits that SHA only after success. Native
mobile lint may skip only after successful explicit change detection says no
native code changed.

Before building and again before publishing, `fork/release-gate.mjs` requires the
successful CI output, checkout HEAD and release SHA to match exactly. Fork-only
changes also trigger checks and releases, so changes to signing or installation
scripts cannot bypass validation. `node --test fork/*.test.mjs` covers the gate's
failure cases and workflow connections. Local tests do not establish remote CI,
repository permissions, signing, Connect configuration or artifact acceptance.
No remote workflow has been triggered during candidate preparation. Keep
publication, promotion and installation as separate approval gates.

Build once from the accepted commit and use the same artifact/version on both
Macs. Verify T3 Connect client configuration, signing identity, the fork updater
and each host's installation/reconnection. Preserve the old app and a consistent
state/settings backup before state-changing upgrades: an old binary may not
read a new schema or event kind. Define the compatible restore path before
shipping, and wait for active turns to finish before restarting either host.
