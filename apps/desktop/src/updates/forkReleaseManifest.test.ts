import { describe, expect, it } from "@effect/vitest";

import { parseFeed, readReleaseManifest } from "./forkReleaseManifest.ts";

const feed = { owner: "nickleuze", repo: "t3code" };
const commit = "d911d164ad0123456789abcdef0123456789abcd";
const forkReleaseJson = JSON.stringify({
  version: "0.0.46-nick.22",
  commit,
  zip: "T3-Code-0.0.46-nick.22-arm64.zip",
  sha256: "abc123",
  builtAt: "2026-10-17T12:00:00Z",
});
const latestMacYml = `version: 0.0.46-nick.22
files:
  - url: T3-Code-0.0.46-nick.22-arm64.zip
    sha512: c2hhNTEyLW9mLXppcA==
    size: 123
path: T3-Code-0.0.46-nick.22-arm64.zip
sha512: c2hhNTEyLW9mLXppcA==
`;

describe("readReleaseManifest", () => {
  it("joins the release's commit, sha256 and the feed's sha512 for its zip", () => {
    expect(
      readReleaseManifest({ version: "0.0.46-nick.22", feed, forkReleaseJson, latestMacYml }),
    ).toEqual({
      ok: true,
      manifest: {
        version: "0.0.46-nick.22",
        commit,
        artifactSha256: "abc123",
        artifactSha512: "c2hhNTEyLW9mLXppcA==",
        feed,
      },
    });
  });

  it("refuses manifests that disagree with the requested release", () => {
    expect(
      readReleaseManifest({ version: "0.0.46-nick.23", feed, forkReleaseJson, latestMacYml }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("not 0.0.46-nick.23") });
    expect(
      readReleaseManifest({
        version: "0.0.46-nick.22",
        feed,
        forkReleaseJson,
        latestMacYml: latestMacYml.replaceAll("arm64.zip", "x64.zip"),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("does not list") });
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
