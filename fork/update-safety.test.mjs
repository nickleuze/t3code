import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

// Only filesystem bindings change. The real foreground and generated installer
// run with fake host commands; HOME and the installed app remain untouched.
// Without a host scenario, reaching any process or app command is a failure.
function fixture(reads, host) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-update-safety-"));
  const work = NodePath.join(dir, "work");
  const bin = NodePath.join(dir, "bin");
  const app = NodePath.join(dir, "Applications", "T3 Code (Alpha).app");
  const backups = NodePath.join(dir, "backups");
  const trash = NodePath.join(dir, "Trash");
  for (const path of [work, bin, trash]) NodeFS.mkdirSync(path);
  writeApp(app, "previous-version");
  const trace = NodePath.join(dir, "trace");
  const counter = NodePath.join(dir, "counter");
  const running = NodePath.join(dir, "running");
  NodeFS.writeFileSync(trace, "");
  NodeFS.writeFileSync(counter, "0");
  NodeFS.writeFileSync(running, "");
  const source = NodeFS.readFileSync(new URL("./update.sh", import.meta.url), "utf8");
  const script = NodePath.join(dir, "update.sh");
  NodeFS.writeFileSync(
    script,
    source
      .replace('APP="/Applications/T3 Code (Alpha).app"', `APP="${app}"`)
      .replace('DB="$HOME/.t3/userdata/statev2.sqlite"', `DB="${dir}/statev2.sqlite"`)
      .replace('WORK="$HOME/.t3/fork-update"', `WORK="${work}"`)
      .replace('BACKUPS="$HOME/.t3/deploy-backups"', `BACKUPS="${backups}"`),
  );
  const unexpected = (name) => `printf "unexpected ${name} %s\\n" "$*" >> "$T3_TEST_TRACE"; exit 1`;
  const commands = {
    scutil: "echo fixture",
    mkdir: '/bin/mkdir "$@"',
    // Both downloads name their output last.
    curl: 'printf "curl %s\\n" "$*" >> "$T3_TEST_TRACE"; : > "${@: -1}"',
    plutil: `case "$2" in
version) echo fixture-version ;;
commit) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
zip) echo fixture.zip ;;
sha256) echo fixture ;;
CFBundleShortVersionString|CFBundleIdentifier)
  value="$(/usr/bin/sed -n "s/^$2=//p" "$6" 2>/dev/null)"; [ -n "$value" ] || exit 1; echo "$value" ;;
*) exit 1 ;;
esac`,
    df: "printf 'Filesystem blocks used available\\nfixture 3000000 0 3000000\\n'",
    shasum: "echo 'fixture  fixture.zip'",
    ditto: `if [ "$1" = -x ]; then
  [ "$T3_TEST_UNPACK" = fail ] && exit 1
  app="\${@: -1}/T3 Code (Alpha).app"; /bin/mkdir -p "$app/Contents"
  printf 'CFBundleShortVersionString=fixture-version\\nCFBundleIdentifier=fixture.alpha\\n' > "$app/Contents/Info.plist"
else /bin/cp -R "$1" "$2"; fi`,
    trash: `printf "trash %s\\n" "$*" >> "$T3_TEST_TRACE"
for path in "$@"; do /bin/mv "$path" "$T3_TEST_TRASH/$(/usr/bin/basename "$path")-$RANDOM" || exit 1; done`,
    rm: unexpected("rm"),
    kill: unexpected("kill"),
    chmod: "exit 0",
    sleep: "exit 0",
    launchctl: `printf "launchctl %s\\n" "$*" >> "$T3_TEST_TRACE"
if [ "$1" = submit ]; then /bin/bash "\${@: -1}"; fi`,
    ps: host
      ? `[ -e "$T3_TEST_RUNNING" ] && printf '%s\\n' "$T3_TEST_APP/Contents/MacOS/T3 Code (Alpha)"; exit 0`
      : unexpected("ps"),
    osascript: host
      ? `printf "osascript %s\\n" "$*" >> "$T3_TEST_TRACE"
case "$T3_TEST_QUIT" in ok) /bin/rm -f "$T3_TEST_RUNNING" ;; fail) exit 1 ;; esac`
      : unexpected("osascript"),
    open: host
      ? `printf "open %s\\n" "$*" >> "$T3_TEST_TRACE"; [ "$T3_TEST_START" = fail ] || : > "$T3_TEST_RUNNING"`
      : unexpected("open"),
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
  const run = (file, args = []) => {
    const result = NodeChildProcess.spawnSync("/bin/bash", [file, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        T3_TEST_TRACE: trace,
        T3_TEST_COUNTER: counter,
        T3_TEST_TRASH: trash,
        T3_TEST_RUNNING: running,
        T3_TEST_APP: app,
        T3_TEST_QUIT: host?.quit ?? "",
        T3_TEST_START: host?.start ?? "",
        T3_TEST_UNPACK: host?.unpack ?? "",
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
  };
  return {
    app,
    backups,
    trash,
    installer: NodePath.join(work, "install-fixture-version.sh"),
    stage: NodePath.join(work, "staged-fixture-version"),
    update: (args) => run(script, args),
    runInstaller: (file) => run(file),
  };
}

function install(reads, args = [], host) {
  return fixture(reads, host).update(args);
}

function writeApp(path, version) {
  NodeFS.mkdirSync(NodePath.join(path, "Contents"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(path, "Contents", "Info.plist"),
    `CFBundleShortVersionString=${version}\nCFBundleIdentifier=fixture.alpha\n`,
  );
}

function appVersion(path) {
  return /CFBundleShortVersionString=(.*)/.exec(
    NodeFS.readFileSync(NodePath.join(path, "Contents", "Info.plist"), "utf8"),
  )?.[1];
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

NodeTest.test("install quits normally and keeps the previous app and every older backup", () => {
  const host = fixture([{ output: "0" }, { output: "0" }], { quit: "ok" });
  const older = ["1", "2", "3", "4"].map((day) =>
    NodePath.join(host.backups, `fork-update-2026010${day}-000000-from-older`),
  );
  for (const path of older) NodeFS.mkdirSync(path, { recursive: true });
  const result = host.update([]);
  NodeAssert.equal(result.status, 0, result.log);
  NodeAssert.match(result.log, /INSTALLED: fork fixture-version/);
  NodeAssert.match(result.trace, /osascript -e tell application id "fixture\.alpha" to quit/);
  NodeAssert.equal(appVersion(host.app), "fixture-version");
  for (const path of older) NodeAssert.ok(NodeFS.existsSync(path), path);
  const backup = NodeFS.readdirSync(host.backups).find((name) =>
    name.endsWith("-from-previous-version"),
  );
  NodeAssert.ok(backup, NodeFS.readdirSync(host.backups).join(", "));
  NodeAssert.equal(
    appVersion(NodePath.join(host.backups, backup, "T3 Code (Alpha).app")),
    "previous-version",
  );
  NodeAssert.ok(!NodeFS.existsSync(host.stage));
  NodeAssert.match(result.trace, /trash .*staged-fixture-version/);
  NodeAssert.doesNotMatch(result.trace, /unexpected/);
});

NodeTest.test("a failed or ignored normal Quit stops without changing the app", () => {
  for (const quit of ["fail", "ignore"]) {
    const host = fixture([{ output: "0" }, { output: "0" }], { quit });
    const result = host.update([]);
    NodeAssert.equal(result.status, 1, result.log);
    NodeAssert.match(result.log, /ABORTED: Alpha did not quit normally; nothing was changed/);
    NodeAssert.equal(appVersion(host.app), "previous-version");
    NodeAssert.ok(!NodeFS.existsSync(host.backups));
    NodeAssert.doesNotMatch(result.trace, /unexpected|open /);
  }
});

NodeTest.test("a staged update installs later only over the app it was staged against", () => {
  const staged = fixture([{ output: "0" }, { output: "0" }], { quit: "ok" });
  const stageOnly = staged.update(["--stage-only"]);
  NodeAssert.equal(stageOnly.status, 0, stageOnly.stderr);
  NodeAssert.match(stageOnly.stdout, /Install with: launchctl submit/);
  NodeAssert.doesNotMatch(stageOnly.trace, /launchctl|osascript|unexpected/);
  NodeAssert.equal(
    appVersion(NodePath.join(staged.stage, "T3 Code (Alpha).app")),
    "fixture-version",
  );
  const installed = staged.runInstaller(staged.installer);
  NodeAssert.equal(installed.status, 0, installed.log);
  NodeAssert.equal(appVersion(staged.app), "fixture-version");

  const changed = fixture([{ output: "0" }, { output: "0" }], { quit: "ok" });
  NodeAssert.equal(changed.update(["--stage-only"]).status, 0);
  writeApp(changed.app, "other-version");
  const result = changed.runInstaller(changed.installer);
  NodeAssert.equal(result.status, 1, result.log);
  NodeAssert.match(
    result.log,
    /ABORTED: installed app is other-version, but this update was staged against previous-version/,
  );
  NodeAssert.doesNotMatch(result.trace, /osascript|unexpected/);
  NodeAssert.equal(appVersion(changed.app), "other-version");
  NodeAssert.ok(!NodeFS.existsSync(changed.backups));
});

NodeTest.test(
  "a new app that does not start goes to the Trash and the previous app returns",
  () => {
    const host = fixture([{ output: "0" }, { output: "0" }], { quit: "ok", start: "fail" });
    const result = host.update([]);
    NodeAssert.equal(result.status, 1, result.log);
    NodeAssert.match(result.log, /FAILED: the new app did not start; restoring the previous app/);
    NodeAssert.equal(appVersion(host.app), "previous-version");
    const trashed = NodeFS.readdirSync(host.trash).map((name) => NodePath.join(host.trash, name));
    NodeAssert.ok(
      trashed.some((path) => appVersion(path) === "fixture-version"),
      trashed.join(", "),
    );
    NodeAssert.doesNotMatch(result.trace, /unexpected/);
  },
);

NodeTest.test("a failed unpack moves the stage and download to the Trash", () => {
  const result = install([{ output: "0" }], [], { unpack: "fail" });
  NodeAssert.equal(result.status, 1, result.stderr);
  NodeAssert.match(result.stdout, /Could not unpack fixture\.zip; nothing was changed/);
  NodeAssert.match(result.trace, /trash .*staged-fixture-version .*fixture\.zip/);
  NodeAssert.doesNotMatch(result.trace, /launchctl|unexpected/);
});
