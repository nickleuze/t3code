#!/usr/bin/env bash
# Prints upstream's stable release tags, newest first, as "<tag> <commit>".
set -euo pipefail

git ls-remote --tags https://github.com/pingdotgg/t3code.git |
  awk '{
    name = $2; sub("refs/tags/", "", name)
    if (sub(/\^\{\}$/, "", name)) peeled[name] = $1; else commit[name] = $1
  }
  END {
    for (name in commit)
      if (name ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/) print name, (name in peeled ? peeled[name] : commit[name])
  }' |
  sort -V -r
