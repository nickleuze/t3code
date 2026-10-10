import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

// Only filesystem bindings change. The real foreground and generated installer
// run with fake host commands; HOME and the installed app remain untouched.
function install(reads, args = []) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-update-safety-"));
  const work = NodePath.join(dir, "work");
  const bin = NodePath.join(dir, "bin");
  NodeFS.mkdirSync(work);
  NodeFS.mkdirSync(bin);
  const trace = NodePath.join(dir, "trace");
  const counter = NodePath.join(dir, "counter");
  NodeFS.writeFileSync(trace, "");
  NodeFS.writeFileSync(counter, "0");
  const source = NodeFS.readFileSync(new URL("./update.sh", import.meta.url), "utf8");
  const script = NodePath.join(dir, "update.sh");
  NodeFS.writeFileSync(
    script,
    source
      .replace('APP="/Applications/T3 Code (Alpha).app"', `APP="${dir}/app"`)
      .replace('DB="$HOME/.t3/userdata/statev2.sqlite"', `DB="${dir}/statev2.sqlite"`)
      .replace('WORK="$HOME/.t3/fork-update"', `WORK="${work}"`)
      .replace('BACKUPS="$HOME/.t3/deploy-backups"', `BACKUPS="${dir}/backups"`),
  );
  const commands = {
    scutil: "echo fixture",
    mkdir: '/bin/mkdir "$@"',
    curl: 'printf "curl %s\\n" "$*" >> "$T3_TEST_TRACE"',
    plutil: `case "$2" in
version) echo fixture-version ;;
commit) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
zip) echo fixture.zip ;;
sha256) echo fixture ;;
CFBundleShortVersionString) echo previous-version ;;
*) exit 1 ;;
esac`,
    df: "printf 'Filesystem blocks used available\\nfixture 3000000 0 3000000\\n'",
    shasum: "echo 'fixture  fixture.zip'",
    ditto: '/bin/mkdir -p "${@: -1}/T3 Code (Alpha).app"',
    rm: 'printf "discard %s\\n" "$*" >> "$T3_TEST_TRACE"',
    chmod: "exit 0",
    sleep: "exit 0",
    launchctl: `printf "launchctl %s\\n" "$*" >> "$T3_TEST_TRACE"
if [ "$1" = submit ]; then /bin/bash "\${@: -1}"; fi`,
    // Unexpected progression must not reach real process or app commands.
    ps: 'printf "unexpected ps\\n" >> "$T3_TEST_TRACE"; exit 1',
    kill: 'printf "unexpected kill\\n" >> "$T3_TEST_TRACE"; exit 1',
    open: 'printf "unexpected open\\n" >> "$T3_TEST_TRACE"; exit 1',
    sqlite3: `count="$(/bin/cat "$T3_TEST_COUNTER")"
printf '%s\\n' "$((count + 1))" > "$T3_TEST_COUNTER"
printf 'sqlite %s\\n' "$count" >> "$T3_TEST_TRACE"
case "$count" in
${reads
  .map((read, index) => `${index}) printf '%s\\n' '${read.output}'; exit ${read.status ?? 0} ;;`)
  .join("\n")}
*) exit 1 ;;
esac`,
  };
  for (const [name, code] of Object.entries(commands))
    NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/bash\n${code}\n`, { mode: 0o700 });
  const result = NodeChildProcess.spawnSync("/bin/bash", [script, ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      T3_TEST_TRACE: trace,
      T3_TEST_COUNTER: counter,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  const log = NodePath.join(work, "update.log");
  return {
    ...result,
    trace: NodeFS.readFileSync(trace, "utf8"),
    log: NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8") : "",
  };
}

NodeTest.test(
  "installer refuses unreadable or malformed active-turn state before downloading",
  () => {
    for (const read of [{ output: "", status: 1 }, { output: "invalid" }, { output: "" }]) {
      const result = install([read]);
      NodeAssert.equal(result.status, 1, result.stderr);
      NodeAssert.match(result.stdout, /Cannot verify active turns/);
      NodeAssert.doesNotMatch(result.trace, /fixture\.zip|launchctl|unexpected/);
    }
  },
);

NodeTest.test("scheduled installer refuses unknown state even with force", () => {
  for (const args of [[], ["--force"]]) {
    const result = install([{ output: "0" }, { output: "", status: 1 }], args);
    NodeAssert.equal(result.status, 1, result.stderr);
    NodeAssert.match(result.trace, /launchctl submit/);
    NodeAssert.match(result.log, /ABORTED: cannot verify active turns/);
    NodeAssert.doesNotMatch(result.log, /Quitting Alpha/);
    NodeAssert.doesNotMatch(result.trace, /unexpected/);
  }
});

NodeTest.test("wait loop aborts if active-turn state becomes unreadable", () => {
  const result = install([{ output: "0" }, { output: "1" }, { output: "", status: 1 }]);
  NodeAssert.equal(result.status, 1, result.stderr);
  NodeAssert.match(result.log, /Waiting for 1 running turn/);
  NodeAssert.match(result.log, /ABORTED: cannot verify active turns/);
  NodeAssert.doesNotMatch(result.log, /Quitting Alpha/);
  NodeAssert.doesNotMatch(result.trace, /unexpected/);
});

NodeTest.test("known busy state still honors the wait deadline without force", () => {
  const result = install([{ output: "1" }, { output: "1" }], ["--wait-mins", "0"]);
  NodeAssert.equal(result.status, 1, result.stderr);
  NodeAssert.match(result.log, /ABORTED: turns still running/);
  NodeAssert.doesNotMatch(result.log, /Quitting Alpha/);
  NodeAssert.doesNotMatch(result.trace, /unexpected/);
});
