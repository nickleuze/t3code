#!/usr/bin/env bash
# Prints upstream's stable and nightly release tags, newest first, as "<tag> <commit>".
# A stable release sorts above the nightlies that led up to it.
set -euo pipefail

git ls-remote --tags https://github.com/pingdotgg/t3code.git |
  awk '{
    name = $2; sub("refs/tags/", "", name)
    if (sub(/\^\{\}$/, "", name)) peeled[name] = $1; else commit[name] = $1
  }
  END {
    for (name in commit) {
      if (match(name, /^v[0-9]+\.[0-9]+\.[0-9]+$/)) build = 999999999
      else if (match(name, /^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+\.[0-9]+$/)) { n = split(name, parts, "."); build = parts[n] }
      else continue
      version = name; sub(/^v/, "", version); sub(/-.*/, "", version)
      print version, build, name, (name in peeled ? peeled[name] : commit[name])
    }
  }' |
  sort -k1,1Vr -k2,2nr |
  cut -d" " -f3-
