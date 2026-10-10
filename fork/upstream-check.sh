#!/usr/bin/env bash
# Report official main against the last accepted upstream commit. Only fetch
# updates Git objects/tracking refs; this never merges or advances acceptance.
set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FORK_REF=HEAD
OFFLINE=0
usage() {
  echo 'Usage: fork/upstream-check.sh [--offline] [--fork-ref REF]'
  echo 'Exit: 0 report complete; 2 first integration/history alignment required; 1 error; 64 usage.'
}
fail() { printf 'Upstream check failed: %s\n' "$*" >&2; exit 1; }
section() { printf '\n## %s\n' "$1"; }
show() { if [ -n "$1" ]; then printf '%s\n' "$1"; else echo 'none'; fi; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --offline) OFFLINE=1 ;;
    --fork-ref)
      if [ "$#" -lt 2 ] || [[ "$2" = -* ]] || [ -z "$2" ]; then usage >&2; exit 64; fi
      FORK_REF="$2"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
  shift
done

cd "$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)"
[ -f "$SCRIPT_DIR/upstream-base" ] || fail 'fork/upstream-base is missing.'
ACCEPTED="$(sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' "$SCRIPT_DIR/upstream-base")"
if [ -n "$ACCEPTED" ] && ! [[ "$ACCEPTED" =~ ^[0-9a-f]{40}$ ]]; then
  fail 'fork/upstream-base must contain one full commit SHA, or comments only before alignment.'
fi
FORK_SHA="$(git rev-parse --verify --end-of-options "$FORK_REF^{commit}")" || fail "Cannot resolve fork ref: $FORK_REF"

if [ "$OFFLINE" = 0 ]; then
  if ! git fetch --quiet --no-tags upstream '+refs/heads/main:refs/remotes/upstream/main'; then
    fail 'Fetching official main failed; cached refs were not used. Use --offline only for a labelled cached report.'
  fi
  echo 'Source: fetched upstream/main successfully.'
else
  echo 'Source: OFFLINE cached upstream/main; freshness has not been verified.'
fi
UPSTREAM_SHA="$(git rev-parse --verify refs/remotes/upstream/main^{commit})" || fail 'upstream/main is unavailable.'
printf 'Fork: %s (%s)\nUpstream: %s\n' "$FORK_REF" "$FORK_SHA" "$UPSTREAM_SHA"
WORKTREE_STATUS="$(git status --porcelain)"
if [ -n "$WORKTREE_STATUS" ]; then
  echo 'Working tree has uncommitted changes; comparisons below use committed refs only.'
fi

section 'Accepted upstream baseline'
if [ -z "$ACCEPTED" ]; then
  echo 'ALIGNMENT REQUIRED: no official upstream commit has been accepted yet.'
  echo 'Validate an isolated candidate first, then record its official upstream SHA in fork/upstream-base.'
  exit 2
fi
git cat-file -e "$ACCEPTED^{commit}" || fail 'The accepted upstream commit is not available locally.'
echo "$ACCEPTED"
if ! git merge-base --is-ancestor "$ACCEPTED" "$UPSTREAM_SHA"; then
  echo 'ALIGNMENT REQUIRED: official main no longer contains the accepted commit; review upstream history.'
  exit 2
fi
if ! git merge-base --is-ancestor "$ACCEPTED" "$FORK_SHA"; then
  echo 'ALIGNMENT REQUIRED: the selected fork ref does not contain the accepted official commit.'
  exit 2
fi

section 'New upstream commits since acceptance'
NEW_COUNT="$(git rev-list --count "$ACCEPTED..$UPSTREAM_SHA")"
printf 'count: %s\n' "$NEW_COUNT"
git log --max-count=30 --format='- %h %s' "$ACCEPTED..$UPSTREAM_SHA"

FORK_FILES="$(git diff --name-only "$ACCEPTED" "$FORK_SHA")"
UPSTREAM_FILES="$(git diff --name-only "$ACCEPTED" "$UPSTREAM_SHA")"
OVERLAP="$(comm -12 <(printf '%s\n' "$FORK_FILES" | sed '/^$/d' | sort) <(printf '%s\n' "$UPSTREAM_FILES" | sed '/^$/d' | sort))"
section 'Files changed by both the fork and upstream'
show "$OVERLAP"

section 'Compatibility review: migrations, contracts, providers, lifecycle and packaging'
REVIEW_FILES="$(git diff --name-status "$ACCEPTED" "$UPSTREAM_SHA" -- \
  apps/server/src/persistence packages/contracts/src \
  apps/server/src/orchestration-v2 apps/server/src/provider apps/server/src/mcp \
  packages/client-runtime/src apps/desktop .github/workflows scripts)"
show "$REVIEW_FILES"
echo 'File overlap and review signals are not merge, runtime or release acceptance.'
