#!/usr/bin/env bash
# Fork-only: runs fork/update.sh on every machine, remote hosts first and this
# Mac last (updating this Mac restarts the app this may be running from).
# Each machine waits for its own running turns before it restarts.
#
# Usage: fork/update-all.sh [update.sh options...]
# Hosts come from T3_FORK_HOSTS (space-separated ssh targets).
set -uo pipefail

HOSTS="${T3_FORK_HOSTS:-nick-mini@100.64.59.85}"
REPOSITORY="${T3_FORK_REPO:-nickleuze/t3code}"
[[ "$REPOSITORY" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || exit 64
SCRIPT="$(cd "$(dirname "$0")" && pwd)/update.sh"
status=0

# Resolve one release before contacting any destination; each installer verifies it again.
requested_version=""
requested_commit=""
options=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --check|--force) ;;
    --wait-mins) [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]] || exit 64; shift ;;
    --version) [ $# -ge 2 ] || exit 64; requested_version="$2"; shift ;;
    --commit) [ $# -ge 2 ] || exit 64; requested_commit="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done
if [ -n "$requested_commit" ] && [ -z "$requested_version" ]; then
  echo "--commit requires --version" >&2
  exit 64
fi
release_url="https://github.com/$REPOSITORY/releases/latest/download"
if [ -n "$requested_version" ]; then
  [[ "$requested_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nick\.[0-9]+$ ]] || exit 64
  release_url="https://github.com/$REPOSITORY/releases/download/fork-v$requested_version"
fi
manifest="$(curl -fsSL --connect-timeout 20 "$release_url/fork-release.json")" || exit 1
version="$(printf '%s' "$manifest" | plutil -extract version raw -o - -)" || exit 1
commit="$(printf '%s' "$manifest" | plutil -extract commit raw -o - -)" || exit 1
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nick\.[0-9]+$ ]] || exit 1
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 1
if { [ -n "$requested_version" ] && [ "$version" != "$requested_version" ]; } || \
   { [ -n "$requested_commit" ] && [ "$commit" != "$requested_commit" ]; }; then
  echo "Release identity mismatch; no machine was contacted." >&2
  exit 1
fi
set -- "${options[@]}" --version "$version" --commit "$commit"

for host in $HOSTS; do
  echo "== $host"
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "env T3_FORK_REPO=$REPOSITORY bash -s --" "$@" < "$SCRIPT"; then
    echo "!! $host failed; continuing with the others"
    status=1
  fi
done

echo "== this Mac"
"$SCRIPT" "$@" || status=1
exit "$status"
