import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";

const version = "0.0.44-nick.6";
const commit = "a".repeat(40);

// Run the real scripts in check-only mode. Every host command is fake; HOME is untouched.
function run(script, args, manifest = { version, commit }) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-update-target-"));
  const trace = NodePath.join(dir, "trace");
  NodeFS.writeFileSync(trace, "");
  const commands = {
    mkdir: "exit 0",
    scutil: "echo fixture",
    curl: 'printf "curl %s\\n" "$*" >> "$T3_TEST_TRACE"; printf "%s" "$T3_TEST_MANIFEST"',
    plutil: `case "$2" in
version) echo "$T3_TEST_VERSION" ;;
commit) echo "$T3_TEST_COMMIT" ;;
zip) echo fixture.zip ;;
sha256) echo fixture ;;
CFBundleShortVersionString) echo 0.0.44-nick.5 ;;
*) exit 1 ;;
esac`,
    ssh: 'printf "ssh %s\\n" "$*" >> "$T3_TEST_TRACE"; /bin/cat > /dev/null',
  };
  for (const [name, code] of Object.entries(commands)) {
    NodeFS.writeFileSync(NodePath.join(dir, name), `#!/bin/bash\n${code}\n`, { mode: 0o700 });
  }
  const result = NodeChildProcess.spawnSync(
    "/bin/bash",
    [NodeURL.fileURLToPath(new URL(script, import.meta.url)), ...args],
    {
      env: {
        ...process.env,
        PATH: `${dir}:/usr/bin:/bin`,
        T3_FORK_HOSTS: "fixture-one fixture-two",
        T3_FORK_REPO: "fixture/fork",
        T3_TEST_TRACE: trace,
        T3_TEST_MANIFEST: JSON.stringify(manifest),
        T3_TEST_VERSION: manifest.version,
        T3_TEST_COMMIT: manifest.commit,
      },
      encoding: "utf8",
    },
  );
  return { ...result, trace: NodeFS.readFileSync(trace, "utf8") };
}

NodeTest.test("the actual installer accepts only the requested metadata identity", () => {
  NodeAssert.equal(
    run("./update.sh", ["--check", "--version", version, "--commit", commit]).status,
    0,
  );
  for (const manifest of [
    { version: "0.0.45-nick.7", commit },
    { version, commit: "b".repeat(40) },
  ]) {
    const result = run(
      "./update.sh",
      ["--check", "--version", version, "--commit", commit],
      manifest,
    );
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.stdout, /Release identity mismatch/);
    NodeAssert.doesNotMatch(result.trace, /fixture\.zip|ssh /);
  }
  NodeAssert.equal(run("./update.sh", ["--check", "--commit", commit]).status, 64);
});

NodeTest.test(
  "update-all resolves one identity and pins every remote and local check to it",
  () => {
    const result = run("./update-all.sh", ["--check"]);
    NodeAssert.equal(result.status, 0, result.stderr);
    const remote = result.trace.split("\n").filter((line) => line.startsWith("ssh "));
    NodeAssert.equal(remote.length, 2);
    for (const line of remote)
      NodeAssert.ok(line.endsWith(`--check --version ${version} --commit ${commit}`), line);
    NodeAssert.match(result.trace, /releases\/latest\/download\/fork-release\.json/);
    NodeAssert.match(
      result.trace,
      new RegExp(`releases/download/fork-v${version}/fork-release.json`),
    );
  },
);

NodeTest.test(
  "update-all refuses mismatched or malformed metadata before contacting any machine",
  () => {
    for (const manifest of [
      { version, commit: "b".repeat(40) },
      { version: "../latest", commit },
      { version, commit: "short" },
    ]) {
      const result = run(
        "./update-all.sh",
        ["--check", "--version", version, "--commit", commit],
        manifest,
      );
      NodeAssert.equal(result.status, 1);
      NodeAssert.doesNotMatch(result.trace, /ssh /);
      NodeAssert.equal(
        result.trace.split("\n").filter((line) => line.startsWith("curl ")).length,
        1,
      );
    }
  },
);
