import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const requiredJobs = [
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
];

/** An omitted job is a broken gate, even if every reported job succeeded. */
export function assertChecks(results) {
  for (const name of requiredJobs) {
    const job = results?.[name];
    const intentionalSkip =
      name === "mobile_native_static_analysis" &&
      job?.result === "skipped" &&
      results?.mobile_native_changes?.result === "success" &&
      results.mobile_native_changes.outputs?.changed === "false";
    if (job?.result !== "success" && !intentionalSkip) {
      throw new Error(`Required fork check ${name} did not succeed.`);
    }
  }
}

export function assertReleaseGate({
  repository,
  ref,
  result,
  checkedSha,
  releaseSha,
  checkoutSha,
}) {
  if (repository !== "nickleuze/t3code" || ref !== "refs/heads/nick/v2") {
    throw new Error("Only the fork's nick/v2 branch can publish.");
  }
  if (result !== "success") throw new Error("Fork CI did not succeed.");
  if (!/^[a-f0-9]{40}$/.test(releaseSha ?? "")) {
    throw new Error("Release commit must be an exact SHA.");
  }
  if (checkedSha !== releaseSha || checkoutSha !== releaseSha) {
    throw new Error("Checked, checked-out and released commits must match exactly.");
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const checkoutSha = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (process.argv[2] === "ci") {
    assertChecks(JSON.parse(process.env.RESULTS ?? "null"));
    if (checkoutSha !== process.env.GITHUB_SHA) throw new Error("CI checkout SHA mismatch.");
    if (!process.env.GITHUB_OUTPUT) throw new Error("Missing CI output destination.");
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `checked-sha=${checkoutSha}\n`);
  } else if (process.argv[2] === "release") {
    assertReleaseGate({
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      result: process.env.CI_RESULT,
      checkedSha: process.env.CI_CHECKED_SHA,
      releaseSha: process.env.GITHUB_SHA,
      checkoutSha,
    });
  } else {
    throw new Error("Usage: node fork/release-gate.mjs <ci|release>");
  }
}
