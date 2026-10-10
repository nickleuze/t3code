#!/usr/bin/env bash
# Fork-only: runs fork/update.sh on every machine, remote hosts first and this
# Mac last (updating this Mac restarts the app this may be running from).
# Each machine waits for its own running turns before it restarts.
#
# Usage: fork/update-all.sh [update.sh options...]
# Hosts come from T3_FORK_HOSTS (space-separated ssh targets).
set -uo pipefail

HOSTS="${T3_FORK_HOSTS:-nick-mini@100.64.59.85}"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/update.sh"
status=0

for host in $HOSTS; do
  echo "== $host"
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" 'bash -s --' "$@" < "$SCRIPT"; then
    echo "!! $host failed; continuing with the others"
    status=1
  fi
done

echo "== this Mac"
"$SCRIPT" "$@" || status=1
exit "$status"
