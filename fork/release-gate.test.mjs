import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assertChecks, assertReleaseGate } from "./release-gate.mjs";

const sha = "98beed1a226c42b85c52ff5ee9d5dbb67d776a77";
const release = {
  repository: "nickleuze/t3code",
  ref: "refs/heads/nick/v2",
  result: "success",
  checkedSha: sha,
  releaseSha: sha,
  checkoutSha: sha,
};
const passingChecks = () =>
  Object.fromEntries(
    [
      "lint",
      "typecheck",
      "build",
      "test",
      "test_web",
      "test_server",
      "transfer-report",
      "rust",
      "mobile_native_changes",
      "mobile_native_static_analysis",
      "release_smoke",
    ].map((name) => [name, { result: "success" }]),
  );

NodeTest.test("publication accepts only the exact checked commit on the release branch", () => {
  NodeAssert.doesNotThrow(() => assertReleaseGate(release));
  for (const change of [
    { checkedSha: "0".repeat(40) },
    { checkoutSha: "0".repeat(40) },
    { checkedSha: undefined },
    { releaseSha: sha.slice(0, 10) },
    { ref: "refs/heads/nick/sync/2026-10-10" },
    { ref: "refs/tags/test" },
    { repository: "pingdotgg/t3code" },
    ...["failure", "cancelled", "skipped", undefined].map((result) => ({ result })),
  ]) {
    NodeAssert.throws(() => assertReleaseGate({ ...release, ...change }));
  }
});

NodeTest.test(
  "CI aggregate fails on every required failed, cancelled, skipped or missing job",
  () => {
    NodeAssert.doesNotThrow(() => assertChecks(passingChecks()));
    for (const job of Object.keys(passingChecks())) {
      for (const result of ["failure", "cancelled", "skipped", undefined]) {
        const results = passingChecks();
        if (result === undefined) delete results[job];
        else results[job].result = result;
        NodeAssert.throws(() => assertChecks(results), undefined, `${job}: ${result}`);
      }
    }
    NodeAssert.throws(() => assertChecks(null));
    NodeAssert.throws(() => assertChecks({}));
  },
);

NodeTest.test("native lint may skip only after successful explicit change detection", () => {
  const results = passingChecks();
  results.mobile_native_static_analysis.result = "skipped";
  results.mobile_native_changes.outputs = { changed: "false" };
  NodeAssert.doesNotThrow(() => assertChecks(results));
  for (const changed of ["true", "", undefined]) {
    results.mobile_native_changes.outputs.changed = changed;
    NodeAssert.throws(() => assertChecks(results));
  }
  results.mobile_native_changes.outputs.changed = "false";
  results.mobile_native_changes.result = "failure";
  NodeAssert.throws(() => assertChecks(results));
});

NodeTest.test("CLI emits an exact checked SHA only after the aggregate passes", () => {
  const output = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-gate-")),
    "output",
  );
  const cwd = NodeURL.fileURLToPath(new URL("..", import.meta.url));
  const checkoutSha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const cli = (mode, env) =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [NodeURL.fileURLToPath(new URL("./release-gate.mjs", import.meta.url)), mode],
      {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
      },
    );
  const ciEnv = {
    RESULTS: JSON.stringify(passingChecks()),
    GITHUB_SHA: checkoutSha,
    GITHUB_OUTPUT: output,
  };
  NodeAssert.equal(cli("ci", ciEnv).status, 0);
  NodeAssert.equal(NodeFS.readFileSync(output, "utf8"), `checked-sha=${checkoutSha}\n`);
  NodeAssert.notEqual(cli("ci", { ...ciEnv, GITHUB_SHA: "0".repeat(40) }).status, 0);
  NodeAssert.notEqual(cli("ci", { ...ciEnv, RESULTS: "{}" }).status, 0);
  // Failed runs cannot append a purported checked SHA.
  NodeAssert.equal(NodeFS.readFileSync(output, "utf8"), `checked-sha=${checkoutSha}\n`);
  const releaseEnv = {
    GITHUB_REPOSITORY: "nickleuze/t3code",
    GITHUB_REF: "refs/heads/nick/v2",
    CI_RESULT: "success",
    CI_CHECKED_SHA: checkoutSha,
    GITHUB_SHA: checkoutSha,
  };
  NodeAssert.equal(cli("release", releaseEnv).status, 0);
  NodeAssert.notEqual(cli("release", { ...releaseEnv, CI_CHECKED_SHA: "0".repeat(40) }).status, 0);
  NodeAssert.notEqual(cli("release", { ...releaseEnv, CI_RESULT: "cancelled" }).status, 0);
});

NodeTest.test("workflows use the checked SHA output and gate both build and publication", () => {
  const ci = NodeFS.readFileSync(
    new URL("../.github/workflows/fork-ci.yml", import.meta.url),
    "utf8",
  );
  const workflow = NodeFS.readFileSync(
    new URL("../.github/workflows/fork-release.yml", import.meta.url),
    "utf8",
  );
  NodeAssert.match(ci, /workflow_call:/);
  NodeAssert.match(ci, /value: \$\{\{ jobs\.check\.outputs\.checked-sha \}\}/);
  NodeAssert.match(ci, /checked-sha: \$\{\{ steps\.gate\.outputs\.checked-sha \}\}/);
  NodeAssert.match(ci, /RESULTS: \$\{\{ toJSON\(needs\) \}\}/);
  NodeAssert.match(workflow, /uses: \.\/\.github\/workflows\/fork-ci\.yml/);
  NodeAssert.match(workflow, /needs: checks/);
  NodeAssert.equal(workflow.match(/run: node fork\/release-gate\.mjs release/g)?.length, 2);
  NodeAssert.equal(
    workflow.match(/CI_CHECKED_SHA: \$\{\{ needs\.checks\.outputs\.checked-sha \}\}/g)?.length,
    2,
  );
  NodeAssert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  NodeAssert.doesNotMatch(ci, /runs-on: blacksmith-/);
  NodeAssert.doesNotMatch(workflow, /paths-ignore:/);
  NodeAssert.ok(
    workflow.indexOf("run: node fork/release-gate.mjs release") <
      workflow.indexOf("      - name: Build\n"),
  );
  NodeAssert.ok(
    workflow.lastIndexOf("run: node fork/release-gate.mjs release") <
      workflow.indexOf("      - name: Publish release\n"),
  );
});

NodeTest.test("native change detection includes the fork-owned workflow that runs its lint", () => {
  const ci = NodeFS.readFileSync(
    new URL("../.github/workflows/fork-ci.yml", import.meta.url),
    "utf8",
  );
  const pattern = ci.match(/pattern='([^']+)'/)?.[1];
  NodeAssert.ok(pattern);
  const matches = new RegExp(pattern);
  for (const path of [
    ".github/workflows/fork-ci.yml",
    ".github/workflows/ci.yml",
    "apps/mobile/native/Fixture.swift",
    "scripts/mobile-native-static-check.ts",
  ]) {
    NodeAssert.ok(matches.test(path), path);
  }
  NodeAssert.equal(matches.test("docs/user/mobile.md"), false);
});
