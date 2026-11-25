#!/usr/bin/env bash
# Git merge driver for agentContextBudget.json, whose numbers are measured byte counts.
# Each side adds or removes its own text, so the merged count is ours + (theirs - base).
# Usage: fork-merge-budget.sh <base> <ours> <theirs>; writes the result to <ours>.
set -euo pipefail
jq -s '.[0] as $base | .[1] as $ours | .[2] as $theirs
  | $ours | with_entries(.value += ($theirs[.key] // 0) - ($base[.key] // 0))' \
  "$1" "$2" "$3" > "$2.merged"
mv "$2.merged" "$2"
