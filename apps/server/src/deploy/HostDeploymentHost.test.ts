// @effect-diagnostics nodeBuiltinImport:off - the test builds a real WAL database on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import type { HostDeploymentRequest } from "@t3tools/contracts";

import {
  approvedArtifact,
  parseAppUpdateFeed,
  parseSigningIdentity,
  snapshotDatabase,
} from "./HostDeploymentHost.ts";

describe("host identity parsing", () => {
  it("reads the update feed the running app was built with", () => {
    expect(
      parseAppUpdateFeed(
        "provider: github\nowner: nickleuze\nrepo: 't3code'\nreleaseType: release\nupdaterCacheDirName: t3-code-updater\n",
      ),
    ).toEqual({ owner: "nickleuze", repo: "t3code" });
    expect(parseAppUpdateFeed("provider: generic\nurl: https://updates.example.com\n")).toBeNull();
  });

  it("names the signing authority and team, which the updater requires to match", () => {
    const codesign = [
      "Executable=/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "Identifier=com.t3tools.t3code",
      "Authority=Developer ID Application: Nick Leuze (ABCDE12345)",
      "Authority=Developer ID Certification Authority",
      "Authority=Apple Root CA",
      "TeamIdentifier=ABCDE12345",
    ].join("\n");
    expect(parseSigningIdentity(codesign)).toBe(
      "Developer ID Application: Nick Leuze (ABCDE12345)",
    );
    expect(parseSigningIdentity("Authority=Apple Development: Nick\nTeamIdentifier=XYZ9\n")).toBe(
      "Apple Development: Nick (XYZ9)",
    );
    expect(parseSigningIdentity("Signature=adhoc\nTeamIdentifier=not set\n")).toBeNull();
  });
});

describe("approvedArtifact", () => {
  const macOnly = {
    artifactSha256: "zip-sha256",
    artifactSha512: "zip-sha512",
  } as HostDeploymentRequest;
  const withWindows = {
    ...macOnly,
    windowsArtifact: { sha256: "exe-sha256", sha512: "exe-sha512" },
  } as HostDeploymentRequest;

  it("pins the file each platform's updater downloads", () => {
    expect(approvedArtifact(withWindows, "darwin")).toEqual({
      sha256: "zip-sha256",
      sha512: "zip-sha512",
    });
    expect(approvedArtifact(withWindows, "win32")).toEqual({
      sha256: "exe-sha256",
      sha512: "exe-sha512",
    });
  });

  it("has nothing for Windows when the release predates its build, or for Linux", () => {
    expect(approvedArtifact(macOnly, "win32")).toBeNull();
    expect(approvedArtifact(withWindows, "linux")).toBeNull();
  });
});

describe("snapshotDatabase", () => {
  // macOS's /usr/bin/sqlite3 -readonly cannot open a WAL-mode file without its -shm.
  it("leaves a copy of a WAL database that is not in WAL mode", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-"));
    try {
      const source = NodePath.join(directory, "state.sqlite");
      const live = new NodeSqlite.DatabaseSync(source);
      live.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);");
      const copy = NodePath.join(directory, "backup", "state.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(copy));
      await snapshotDatabase(source, copy);
      live.close();

      const readOnly = new NodeSqlite.DatabaseSync(copy, { readOnly: true });
      try {
        expect(readOnly.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
        expect(readOnly.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        expect(readOnly.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
      } finally {
        readOnly.close();
      }
      expect(NodeFS.readdirSync(NodePath.dirname(copy))).toEqual(["state.sqlite"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
