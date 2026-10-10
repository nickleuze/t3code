import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd, ...args) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const commit = (cwd, files, message) => {
  for (const [name, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, name), text);
  }
  git(cwd, "add", "--", ...Object.keys(files));
  git(cwd, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

function fixture() {
  // Keep generated repositories in the OS temp directory for failure inspection.
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-upstream-check-test-"));
  const fork = NodePath.join(dir, "fork");
  const upstream = NodePath.join(dir, "upstream");
  NodeFS.mkdirSync(NodePath.join(fork, "fork"), { recursive: true });
  git(fork, "init", "--initial-branch=main");
  git(fork, "config", "user.name", "Fork checker test");
  git(fork, "config", "user.email", "test@example.invalid");
  const base = commit(
    fork,
    {
      "shared.txt": "base\n",
      "apps/server/src/persistence/Migrations/001.ts": "baseline migration\n",
      "packages/contracts/src/obsolete.ts": "old contract\n",
      "fork/upstream-base": "# Not accepted yet.\n",
      "fork/upstream-check.sh": NodeFS.readFileSync(
        new URL("./upstream-check.sh", import.meta.url),
        "utf8",
      ),
    },
    "base",
  );
  git(dir, "clone", "--quiet", fork, upstream);
  git(upstream, "config", "user.name", "Fork checker test");
  git(upstream, "config", "user.email", "test@example.invalid");
  git(fork, "remote", "add", "upstream", upstream);
  git(fork, "switch", "-c", "nick/test");
  NodeFS.writeFileSync(NodePath.join(fork, "fork/upstream-base"), base + "\n");
  const check = (...args) =>
    NodeChildProcess.spawnSync("bash", [NodePath.join(fork, "fork/upstream-check.sh"), ...args], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
  return { dir, fork, upstream, base, check };
}

NodeTest.test(
  "fresh reports identify overlap and changed migrations without changing fork state",
  () => {
    const f = fixture();
    commit(
      f.fork,
      { "shared.txt": "personal\n", "personal.txt": "preference\n" },
      "personal feature",
    );
    git(f.upstream, "update-index", "--force-remove", "packages/contracts/src/obsolete.ts");
    const latest = commit(
      f.upstream,
      {
        "shared.txt": "official\n",
        "apps/server/src/persistence/Migrations/001.ts": "changed migration\n",
        "packages/contracts/src/commands.ts": "changed contract\n",
      },
      "official update",
    );
    const before = [git(f.fork, "rev-parse", "HEAD"), git(f.fork, "status", "--porcelain")];
    const r = f.check();
    NodeAssert.equal(r.status, 0, r.stderr);
    NodeAssert.match(r.stdout, /Source: fetched/);
    NodeAssert.ok(r.stdout.includes(latest));
    NodeAssert.match(r.stdout, /count: 1/);
    NodeAssert.match(r.stdout, /changed by both[^\n]*\nshared\.txt\n/);
    NodeAssert.match(r.stdout, /M\tapps\/server\/src\/persistence\/Migrations\/001\.ts/);
    NodeAssert.match(r.stdout, /D\tpackages\/contracts\/src\/obsolete\.ts/);
    NodeAssert.match(r.stdout, /packages\/contracts\/src\/commands\.ts/);
    NodeAssert.deepEqual(
      [git(f.fork, "rev-parse", "HEAD"), git(f.fork, "status", "--porcelain")],
      before,
    );
  },
);

NodeTest.test("an unset or invalid baseline never silently accepts upstream", () => {
  const f = fixture();
  NodeFS.writeFileSync(NodePath.join(f.fork, "fork/upstream-base"), "# No accepted commit.\n");
  const r = f.check();
  NodeAssert.equal(r.status, 2, r.stderr);
  NodeAssert.match(r.stdout, /ALIGNMENT REQUIRED: no official upstream commit/);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(f.fork, "fork/upstream-base"), "utf8"),
    "# No accepted commit.\n",
  );
  NodeFS.writeFileSync(NodePath.join(f.fork, "fork/upstream-base"), "main\n");
  NodeAssert.equal(f.check("--offline").status, 1);
  NodeAssert.equal(f.check("--fork-ref").status, 64);
});

NodeTest.test("acceptance must be in both histories, including after upstream rewrites", () => {
  const f = fixture();
  NodeAssert.equal(f.check().status, 0);
  const tree = git(f.fork, "rev-parse", "HEAD^{tree}");
  const unrelated = git(
    f.fork,
    "-c",
    "commit.gpgsign=false",
    "commit-tree",
    tree,
    "-m",
    "unrelated root",
  );
  git(f.fork, "branch", "disconnected", unrelated);
  const wrongFork = f.check("--offline", "--fork-ref", "disconnected");
  NodeAssert.equal(wrongFork.status, 2, wrongFork.stderr);
  NodeAssert.match(wrongFork.stdout, /selected fork ref does not contain/);
  const upstreamRoot = git(
    f.upstream,
    "-c",
    "commit.gpgsign=false",
    "commit-tree",
    git(f.upstream, "rev-parse", "HEAD^{tree}"),
    "-m",
    "rewritten root",
  );
  git(f.upstream, "update-ref", "refs/heads/main", upstreamRoot);
  const rewritten = f.check();
  NodeAssert.equal(rewritten.status, 2, rewritten.stderr);
  NodeAssert.match(rewritten.stdout, /official main no longer contains/);
});

NodeTest.test("fetch failures cannot fall back to stale refs; offline mode is explicit", () => {
  const f = fixture();
  NodeAssert.equal(f.check().status, 0);
  git(f.upstream, "branch", "-m", "renamed-main");
  const missing = f.check();
  NodeAssert.equal(missing.status, 1);
  NodeAssert.match(missing.stderr, /cached refs were not used/);
  NodeAssert.doesNotMatch(missing.stdout, /New upstream commits/);
  const cached = f.check("--offline");
  NodeAssert.equal(cached.status, 0, cached.stderr);
  NodeAssert.match(cached.stdout, /OFFLINE cached.*freshness has not been verified/);
  git(f.fork, "remote", "set-url", "upstream", NodePath.join(f.dir, "missing-repository"));
  NodeAssert.equal(f.check().status, 1);
  NodeAssert.equal(f.check("--offline", "--fork-ref", "missing-ref").status, 1);
});
