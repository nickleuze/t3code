import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerSettings,
  type Project,
  type ServerProvider,
} from "@t3tools/contracts";
import { projectLaunchDefaults, supportedRuntimeMode } from "./ProjectLaunchDefaults.ts";
const instanceId = ProviderInstanceId.make("fake");
const model = (slug: string) => ({ instanceId, model: slug });
const project = {
  id: ProjectId.make("fixture"),
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
} as Project;
const provider = {
  instanceId,
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  supportedRuntimeModes: ["approval-required", "auto"],
  models: [
    { slug: "legacy", isLegacy: true },
    { slug: "first", isDefault: false },
    { slug: "second", isDefault: true },
  ],
} as unknown as ServerProvider;
describe("project launch defaults", () => {
  it("resolves project then settings then first available non-legacy model", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: model("second"),
      projectSettingsFolded: false,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
      },
    };
    expect(
      projectLaunchDefaults(settings, { ...project, defaultModelSelection: model("first") }, [
        provider,
      ]).modelSelection,
    ).toEqual(model("first"));
    expect(projectLaunchDefaults(settings, project, [provider]).modelSelection).toEqual(
      model("second"),
    );
    expect(
      projectLaunchDefaults({ ...settings, defaultModelSelection: null }, project, [provider])
        .modelSelection,
    ).toEqual(model("first"));
    expect(
      projectLaunchDefaults(settings, { ...project, defaultModelSelection: model("legacy") }, [
        provider,
      ]).modelSelection,
    ).toEqual(model("second"));
  });
  it("uses folded project settings and skips unavailable providers", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsFolded: true,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
      },
      projectSettingsOverrides: {
        [project.id]: {
          defaultModelSelection: model("second"),
          defaultRuntimeMode: "full-access" as const,
          defaultThreadEnvMode: "local" as const,
        },
      },
    };
    expect(projectLaunchDefaults(settings, project, [provider])).toEqual({
      modelSelection: model("second"),
      runtimeMode: "full-access",
      envMode: "local",
    });
    for (const unavailable of [
      { enabled: false },
      { installed: false },
      { availability: "unavailable" as const },
      { auth: { ...provider.auth, status: "unauthenticated" as const } },
    ])
      expect(
        projectLaunchDefaults(settings, project, [{ ...provider, ...unavailable }]).modelSelection,
      ).toBeNull();
  });
  it("defaults to worktree and clamps runtime to supported picker order", () => {
    expect(projectLaunchDefaults(DEFAULT_SERVER_SETTINGS, project, [provider]).envMode).toBe(
      "worktree",
    );
    expect(supportedRuntimeMode("full-access", provider)).toBe("approval-required");
    expect(supportedRuntimeMode("auto", provider)).toBe("auto");
    expect(supportedRuntimeMode("auto", undefined)).toBe("auto");
  });
});
