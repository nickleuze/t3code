#!/usr/bin/env bash
# Runs the unit tests in and beside the files the fork's patches change (browser tests
# need a browser). A failing test blocks the sync only when it passes on the upstream
# commit, so upstream's own broken tests don't hold back a good rebase.
# Usage: fork-check-tests.sh <upstream commit>
set -euo pipefail
export LC_ALL=C
upstream="$1"
root="$PWD"
# The real path: vitest loads itself twice through a symlinked one (macOS /var).
work="$(cd "$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fork-check-tests.XXXXXX")" && pwd -P)"

shopt -s nullglob
tests=()
for file in $(git diff --name-only "${upstream}..HEAD" -- '*.ts' '*.tsx'); do
  stem="${file%.*}"; stem="${stem%.test}"
  for test_file in "$stem".test.ts "$stem".test.tsx "$stem".*.test.ts "$stem".*.test.tsx; do
    [[ "$test_file" == *.browser.test.* ]] || tests+=("$test_file")
  done
done
(( ${#tests[@]} )) || exit 0
tests=($(printf '%s\n' "${tests[@]}" | sort -u))

# Prints "<file> :: <test>" per failed test, or "<file> :: (file)" when the file itself failed.
failures() {
  node -e '
    const [report, root] = process.argv.slice(1);
    const fs = require("node:fs");
    const path = require("node:path");
    const realRoot = fs.realpathSync(root);
    for (const file of require(report).testResults) {
      const name = path.relative(realRoot, fs.realpathSync(file.name));
      const failed = file.assertionResults.filter((test) => test.status === "failed");
      if (failed.length === 0 && file.status === "failed") console.log(`${name} :: (file)`);
      for (const test of failed) console.log(`${name} :: ${test.fullName}`);
    }' "$1" "$2" | sort -u
}

if vp test run --reporter=default --reporter=json --outputFile.json="$work/patched.json" "${tests[@]}"; then
  exit 0
fi
test -s "$work/patched.json" || { echo "The test run failed before writing a report."; exit 1; }
patched="$(failures "$work/patched.json" "$root")"
test -n "$patched" || { echo "The test run failed without a failing test."; exit 1; }

echo "Running the failing test files on upstream ${upstream} to compare."
upstream_tree="$work/upstream"
git worktree add --detach --no-checkout "$upstream_tree" "$upstream"
trap 'git -C "$root" worktree remove --force "$upstream_tree" 2>/dev/null || true' EXIT
git -C "$upstream_tree" sparse-checkout set --no-cone '/*' '!/.repos/'
git -C "$upstream_tree" checkout --quiet
upstream_failed=""
(
  cd "$upstream_tree"
  existing=()
  for file in $(printf '%s\n' "$patched" | sed 's/ :: .*//' | sort -u); do
    [ -f "$file" ] && existing+=("$file")
  done
  (( ${#existing[@]} )) || exit 0
  export PATH="$PWD/node_modules/.bin:$PATH"
  vp install
  hash -r # use this tree's vp from now on, or vitest loads twice
  vp test run --reporter=json --outputFile.json="$work/upstream.json" "${existing[@]}" >/dev/null 2>&1 || true
)
if [ -s "$work/upstream.json" ]; then
  upstream_failed="$(failures "$work/upstream.json" "$upstream_tree")"
fi

new_failures="$(comm -23 <(printf '%s\n' "$patched") <(printf '%s\n' "$upstream_failed"))"
if [ -n "$new_failures" ]; then
  echo "::error::These tests fail with the patches but pass on upstream:"
  printf '%s\n' "$new_failures"
  exit 1
fi
echo "::warning::These tests fail on upstream ${upstream} too, so they don't block the sync:"
printf '%s\n' "$patched"
