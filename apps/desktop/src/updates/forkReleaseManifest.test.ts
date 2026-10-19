import { describe, expect, it } from "@effect/vitest";

import { parseFeed, readReleaseManifest } from "./forkReleaseManifest.ts";

const feed = { owner: "nickleuze", repo: "t3code" };
const commit = "d911d164ad0123456789abcdef0123456789abcd";
const macOnlyReleaseJson = JSON.stringify({
  version: "0.0.46-nick.22",
  commit,
  zip: "T3-Code-0.0.46-nick.22-arm64.zip",
  sha256: "abc123",
  builtAt: "2026-10-17T12:00:00Z",
});
const forkReleaseJson = JSON.stringify({
  ...JSON.parse(macOnlyReleaseJson),
  exe: "T3-Code-0.0.46-nick.22-x64.exe",
  exeSha256: "def456",
});
const latestMacYml = `version: 0.0.46-nick.22
files:
  - url: T3-Code-0.0.46-nick.22-arm64.zip
    sha512: c2hhNTEyLW9mLXppcA==
    size: 123
path: T3-Code-0.0.46-nick.22-arm64.zip
sha512: c2hhNTEyLW9mLXppcA==
`;
const latestYml = `version: 0.0.46-nick.22
files:
  - url: T3-Code-0.0.46-nick.22-x64.exe
    sha512: c2hhNTEyLW9mLWV4ZQ==
    size: 456
path: T3-Code-0.0.46-nick.22-x64.exe
sha512: c2hhNTEyLW9mLWV4ZQ==
`;

describe("readReleaseManifest", () => {
  it("joins the release's commit, sha256 and the feeds' sha512 for its zip and installer", () => {
    expect(
      readReleaseManifest({
        version: "0.0.46-nick.22",
        feed,
        forkReleaseJson,
        latestMacYml,
        latestYml,
      }),
    ).toEqual({
      ok: true,
      manifest: {
        version: "0.0.46-nick.22",
        commit,
        artifactSha256: "abc123",
        artifactSha512: "c2hhNTEyLW9mLXppcA==",
        windowsArtifact: { sha256: "def456", sha512: "c2hhNTEyLW9mLWV4ZQ==" },
        feed,
      },
    });
  });

  it("reads a macOS-only release without a Windows artifact", () => {
    const result = readReleaseManifest({
      version: "0.0.46-nick.22",
      feed,
      forkReleaseJson: macOnlyReleaseJson,
      latestMacYml,
      latestYml: null,
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && "windowsArtifact" in result.manifest).toBe(false);
  });

  it("refuses manifests that disagree with the requested release", () => {
    expect(
      readReleaseManifest({
        version: "0.0.46-nick.23",
        feed,
        forkReleaseJson,
        latestMacYml,
        latestYml,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("not 0.0.46-nick.23") });
    expect(
      readReleaseManifest({
        version: "0.0.46-nick.22",
        feed,
        forkReleaseJson,
        latestMacYml: latestMacYml.replaceAll("arm64.zip", "x64.zip"),
        latestYml,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("does not list") });
    // A release that names an installer must list it in its Windows feed.
    expect(
      readReleaseManifest({
        version: "0.0.46-nick.22",
        feed,
        forkReleaseJson,
        latestMacYml,
        latestYml: null,
      }),
    ).toMatchObject({
      ok: false,
      reason: "latest.yml does not list T3-Code-0.0.46-nick.22-x64.exe.",
    });
  });
});

describe("parseFeed", () => {
  it("reads the GitHub feed from app-update.yml", () => {
    expect(
      parseFeed("provider: github\nowner: nickleuze\nrepo: t3code\nreleaseType: release\n"),
    ).toEqual(feed);
    expect(parseFeed("provider: generic\nurl: https://example.com\n")).toBeNull();
  });
});
