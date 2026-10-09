import { describe, expect, it } from "vite-plus/test";

import { bundleShortVersion, forkBuildNumber, isNewerForkVersion } from "./ForkUpdate.ts";

describe("fork update versions", () => {
  it("reads the run number of fork builds only", () => {
    expect(forkBuildNumber("0.0.44-nick.12")).toBe(12);
    expect(forkBuildNumber("0.0.44")).toBeNull();
    expect(forkBuildNumber("0.0.43-nightly.20260926.2318")).toBeNull();
  });

  it("compares by run number, ignoring the upstream base version", () => {
    expect(isNewerForkVersion("0.0.44-nick.10", "0.0.44-nick.9")).toBe(true);
    expect(isNewerForkVersion("0.0.45-nick.4", "0.0.44-nick.4")).toBe(false);
    expect(isNewerForkVersion("0.0.44-nick.5", "0.0.44")).toBe(false);
  });

  it("reads the version from an XML Info.plist", () => {
    const plist = `<dict>\n\t<key>CFBundleName</key>\n\t<string>T3</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.0.44-nick.4</string>\n</dict>`;
    expect(bundleShortVersion(plist)).toBe("0.0.44-nick.4");
    expect(bundleShortVersion("<dict></dict>")).toBeNull();
  });
});
