import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

import { forkPath, generateForkCi, upstreamPath } from "./sync-ci.mjs";

const upstream = NodeFS.readFileSync(upstreamPath, "utf8");

NodeTest.test("fork-ci.yml is generated from the current upstream ci.yml", () => {
  NodeAssert.equal(
    NodeFS.readFileSync(forkPath, "utf8"),
    generateForkCi(upstream),
    "fork-ci.yml is stale; run node fork/sync-ci.mjs",
  );
});

NodeTest.test("a reshaped upstream workflow fails instead of generating a different one", () => {
  NodeAssert.throws(
    () => generateForkCi(upstream.replace("      - main\n", "      - main\n      - next\n")),
    /triggers: 0 matches/,
  );
  NodeAssert.throws(
    () => generateForkCi(`${upstream}  windows:\n    runs-on: blacksmith-4vcpu-windows-2025\n`),
    /Blacksmith runner/,
  );
});
