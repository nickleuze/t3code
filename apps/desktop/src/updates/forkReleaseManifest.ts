import type { DesktopReleaseManifestResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const ForkReleaseJson = Schema.Struct({
  version: Schema.String,
  commit: Schema.String,
  zip: Schema.String,
  sha256: Schema.String,
  /** The Windows installer, in releases since the fork published one. */
  exe: Schema.optionalKey(Schema.String),
  exeSha256: Schema.optionalKey(Schema.String),
});
const decodeForkReleaseJson = Schema.decodeUnknownOption(Schema.fromJsonString(ForkReleaseJson));

const FULL_COMMIT = /^[0-9a-f]{40}$/i;

/** `owner` and `repo` from electron-builder's `app-update.yml`. */
export function parseFeed(raw: string): { readonly owner: string; readonly repo: string } | null {
  const value = (key: string) =>
    raw
      .split("\n")
      .map((line) => line.match(new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`))?.[1])
      .find((match) => match !== undefined);
  const owner = value("owner");
  const repo = value("repo");
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

/** The sha512 an updater feed (`latest-mac.yml`, `latest.yml`) lists for `file`. */
function parseFeedSha512(raw: string, file: string): string | null {
  const lines = raw.split("\n").map((line) => line.trim());
  const entry = lines.findIndex((line) => line === `- url: ${file}` || line === `url: ${file}`);
  if (entry === -1) return null;
  for (const line of lines.slice(entry + 1)) {
    if (line.startsWith("- url:")) break;
    const sha512 = line.match(/^sha512:\s*(\S+)$/)?.[1];
    if (sha512 !== undefined) return sha512;
  }
  return null;
}

/** Checks a release's own manifests against each other and the requested version. */
export function readReleaseManifest(input: {
  readonly version: string;
  readonly feed: { readonly owner: string; readonly repo: string };
  readonly forkReleaseJson: string;
  readonly latestMacYml: string;
  /** Null when the release has no readable `latest.yml`. */
  readonly latestYml: string | null;
}): DesktopReleaseManifestResult {
  const release = decodeForkReleaseJson(input.forkReleaseJson);
  if (Option.isNone(release)) {
    return { ok: false, reason: "The release's fork-release.json could not be read." };
  }
  if (release.value.version !== input.version) {
    return {
      ok: false,
      reason: `fork-release.json describes ${release.value.version}, not ${input.version}.`,
    };
  }
  if (!FULL_COMMIT.test(release.value.commit)) {
    return { ok: false, reason: "fork-release.json does not name a full source commit." };
  }
  const sha512 = parseFeedSha512(input.latestMacYml, release.value.zip);
  if (sha512 === null) {
    return { ok: false, reason: `latest-mac.yml does not list ${release.value.zip}.` };
  }
  const { exe, exeSha256 } = release.value;
  let windowsArtifact: { readonly sha256: string; readonly sha512: string } | undefined;
  if (exe !== undefined && exeSha256 !== undefined) {
    const exeSha512 = input.latestYml === null ? null : parseFeedSha512(input.latestYml, exe);
    if (exeSha512 === null) {
      return { ok: false, reason: `latest.yml does not list ${exe}.` };
    }
    windowsArtifact = { sha256: exeSha256, sha512: exeSha512 };
  }
  return {
    ok: true,
    manifest: {
      version: release.value.version,
      commit: release.value.commit.toLowerCase(),
      artifactSha256: release.value.sha256,
      artifactSha512: sha512,
      ...(windowsArtifact === undefined ? {} : { windowsArtifact }),
      feed: input.feed,
    },
  };
}

/**
 * The published release for `version`, from the feed this app updates from.
 * Approval shows exactly what the hosts will be asked to install.
 */
export const fetchReleaseManifest = Effect.fn("desktop.updates.fetchReleaseManifest")(function* (
  version: string,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects());

  const feed = yield* fileSystem.readFileString(environment.appUpdateYmlPath).pipe(
    Effect.map(parseFeed),
    Effect.orElseSucceed(() => null),
  );
  if (feed === null) {
    return {
      ok: false,
      reason: "This app has no update feed, so it cannot look up a release.",
    } satisfies DesktopReleaseManifestResult;
  }
  const asset = (name: string) =>
    client
      .get(
        `https://github.com/${feed.owner}/${feed.repo}/releases/download/fork-v${encodeURIComponent(version)}/${name}`,
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
      );
  return yield* Effect.all([
    asset("fork-release.json"),
    asset("latest-mac.yml"),
    // Releases before the Windows build have no latest.yml.
    asset("latest.yml").pipe(Effect.orElseSucceed(() => null)),
  ]).pipe(
    Effect.map(([forkReleaseJson, latestMacYml, latestYml]) =>
      readReleaseManifest({ version, feed, forkReleaseJson, latestMacYml, latestYml }),
    ),
    Effect.orElseSucceed((): DesktopReleaseManifestResult => ({
      ok: false,
      reason: `Release fork-v${version} is not published on ${feed.owner}/${feed.repo}.`,
    })),
  );
});
