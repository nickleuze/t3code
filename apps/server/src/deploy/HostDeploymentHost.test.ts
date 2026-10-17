import { describe, expect, it } from "@effect/vitest";

import { parseAppUpdateFeed, parseSigningIdentity } from "./HostDeploymentHost.ts";

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
