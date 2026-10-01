#!/usr/bin/env bash
# Fork-only: reports how upstream's v2 branch has moved relative to nick/v2, for
# the daily "is it safe to update?" check. Read-only apart from `git fetch`.
# Expects remotes `origin` (nickleuze/t3code) and `upstream` (pingdotgg/t3code).
set -uo pipefail

FORK_BRANCH="origin/nick/v2"
V2_BRANCH="upstream/t3code/codex-turn-mapping"
MAIN_BRANCH="upstream/main"
MIGRATIONS="apps/server/src/persistence/Migrations"

git fetch --quiet --prune origin
git fetch --quiet --prune upstream

section() { printf '\n## %s\n' "$1"; }

if ! git rev-parse --verify --quiet "$V2_BRANCH" >/dev/null; then
  section "Upstream v2 branch missing"
  echo "$V2_BRANCH no longer exists. Upstream may have merged v2 into main or renamed the branch."
fi

# Upstream's v2 commits that the fork was built on; if main contains them, v2 has landed on main.
FORK_BASE=$(git merge-base "$FORK_BRANCH" "$V2_BRANCH" 2>/dev/null || git merge-base "$FORK_BRANCH" "$MAIN_BRANCH")

section "v2 on upstream main"
if git merge-base --is-ancestor "$FORK_BASE" "$MAIN_BRANCH"; then
  echo "YES: upstream main contains the v2 commits the fork is based on. The official Nightly will ship v2."
else
  echo "no"
fi

git rev-parse --verify --quiet "$V2_BRANCH" >/dev/null || exit 0

section "New upstream v2 commits"
echo "count: $(git rev-list --count "$FORK_BRANCH..$V2_BRANCH")"
git log --no-merges --format='- %h %s' "$FORK_BRANCH..$V2_BRANCH" | head -80

section "Fork-only commits on nick/v2"
git log --no-merges --format='- %h %s' "$V2_BRANCH..$FORK_BRANCH"

section "Merge conflicts if updated now"
if CONFLICTS=$(git merge-tree --write-tree --name-only "$FORK_BRANCH" "$V2_BRANCH" 2>&1); then
  echo "none"
else
  echo "$CONFLICTS" | tail -n +2 | sed -n '/^$/q;p' | sed 's/^/- /'
fi

section "Files changed by both the fork and upstream"
comm -12 \
  <(git diff --name-only "$FORK_BASE" "$FORK_BRANCH" | sort) \
  <(git diff --name-only "$FORK_BASE" "$V2_BRANCH" | sort) | sed 's/^/- /'

section "New upstream database migrations"
git diff --name-only --diff-filter=A "$FORK_BASE" "$V2_BRANCH" -- "$MIGRATIONS" | sed 's/^/- /'
