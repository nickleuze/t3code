// Fork-only: generates .github/workflows/fork-ci.yml from upstream's ci.yml.
//
// The fork runs upstream's checks unchanged, on GitHub-hosted runners, for its
// own branches, and as a reusable workflow for fork-release.yml. Each edit
// below must match upstream exactly, so a reshaped ci.yml fails here instead
// of producing a silently different workflow. fork/sync-ci.test.mjs fails
// while fork-ci.yml is out of date.
//
// Usage: node fork/sync-ci.mjs   (rewrites fork-ci.yml after an upstream sync)
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const workflows = new URL("../.github/workflows/", import.meta.url);
export const upstreamPath = new URL("ci.yml", workflows);
export const forkPath = new URL("fork-ci.yml", workflows);

const HEADER = `# Generated from ci.yml by fork/sync-ci.mjs; do not edit by hand.
# After an upstream sync, run: node fork/sync-ci.mjs
`;

/** [description, pattern, replacement, expected match count (undefined: at least one)] */
const EDITS = [
  ["workflow name", /^name: CI\n/m, "name: Fork CI\n", 1],
  [
    "triggers",
    /^on:\n {2}pull_request:\n {2}push:\n {4}branches:\n {6}- main\n\n/m,
    `on:
  push:
    branches: [nick/v2, nick/integration, "nick/sync/**", "nick/feat/**"]
  pull_request:
  workflow_dispatch:
  workflow_call:

`,
    1,
  ],
  // Called from fork-release.yml with the same SHA as the push run; a shared
  // group would cancel one of them.
  [
    "concurrency group",
    /^ {2}group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}$/m,
    "  group: fork-ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}",
    1,
  ],
  ["Linux runners", /runs-on: blacksmith-\d+vcpu-ubuntu-\d+$/gm, "runs-on: ubuntu-24.04"],
  ["macOS runners", /runs-on: blacksmith-\d+vcpu-macos-\d+$/gm, "runs-on: macos-15"],
  // GitHub-hosted runners are slower than Blacksmith's.
  ["job timeouts", /^ {4}timeout-minutes: 10$/gm, "    timeout-minutes: 30"],
  ["Blacksmith apt mirrors", /^ {6}- uses: \.\/\.github\/actions\/setup-apt-mirrors\n\n/gm, "", 2],
  ["Blacksmith apt mirror rewrite", /^.*\/etc\/apt\/blacksmith-ubuntu-mirrors\.txt.*\n/gm, "", 2],
  [
    "fork script tests",
    /^ {6}- name: Check\n {8}run: vp check\n/m,
    `      - name: Test fork scripts
        run: node --test fork/*.test.mjs

      - name: Check
        run: vp check
`,
    1,
  ],
  [
    "native mobile change detection",
    /\^\\\.github\/workflows\/ci\\\.yml\$/g,
    "^\\.github/workflows/(ci|fork-ci)\\.yml$",
    1,
  ],
];

export function generateForkCi(upstream) {
  let output = upstream;
  for (const [description, pattern, replacement, expected] of EDITS) {
    const matches = output.match(pattern)?.length ?? 0;
    if (expected === undefined ? matches === 0 : matches !== expected) {
      throw new Error(
        `Upstream ci.yml changed shape (${description}: ${matches} matches); update fork/sync-ci.mjs.`,
      );
    }
    output = output.replace(pattern, replacement);
  }
  if (/runs-on: blacksmith/.test(output)) {
    throw new Error("Upstream ci.yml uses a Blacksmith runner the fork does not map.");
  }
  return HEADER + output;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  NodeFS.writeFileSync(forkPath, generateForkCi(NodeFS.readFileSync(upstreamPath, "utf8")));
}
