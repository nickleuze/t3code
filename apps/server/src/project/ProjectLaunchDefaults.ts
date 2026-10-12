import {
  ServerSettingsError,
  type ModelSelection,
  type Project,
  type RuntimeMode,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";

/** Shared by outside thread launches and ticket launches; provider options survive defaults. */
export function projectLaunchDefaults(
  settings: ServerSettings,
  project: Project,
  providers: readonly ServerProvider[],
) {
  const resolved = resolveProjectSettings(settings, project.id, project).settings;
  const available = providers.filter(
    (p) =>
      p.enabled &&
      p.installed &&
      p.availability !== "unavailable" &&
      p.auth.status !== "unauthenticated",
  );
  const configured = [resolved.defaultModelSelection, settings.defaultModelSelection].find(
    (selection) =>
      selection &&
      available.some(
        (p) =>
          p.instanceId === selection.instanceId &&
          p.models.find((m) => m.slug === selection.model)?.isLegacy !== true,
      ),
  );
  const fallback = available.flatMap((p) =>
    p.models.filter((m) => !m.isLegacy).map((m) => ({ instanceId: p.instanceId, model: m.slug })),
  )[0];
  return {
    modelSelection: configured ?? fallback ?? null,
    runtimeMode: resolved.defaultRuntimeMode,
    envMode: resolved.defaultThreadEnvMode ?? "worktree",
  };
}

export function supportedRuntimeMode(
  mode: RuntimeMode,
  provider: ServerProvider | undefined,
): RuntimeMode {
  const modes = provider?.supportedRuntimeModes;
  if (!modes?.length || modes.includes(mode)) return mode;
  // Same ordered preference used by the composer runtime picker.
  return (
    (["approval-required", "auto-accept-edits", "auto", "full-access"] as const).find((m) =>
      modes.includes(m),
    ) ?? mode
  );
}

export class ProjectLaunchDefaults extends Context.Service<
  ProjectLaunchDefaults,
  {
    readonly resolve: (
      project: Project,
    ) => Effect.Effect<ReturnType<typeof projectLaunchDefaults>, ServerSettingsError>;
    readonly runtimeMode: (
      mode: RuntimeMode,
      selection: ModelSelection,
    ) => Effect.Effect<RuntimeMode>;
  }
>()("t3/project/ProjectLaunchDefaults") {}
const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  return ProjectLaunchDefaults.of({
    resolve: (project) =>
      Effect.gen(function* () {
        return projectLaunchDefaults(
          yield* settings.getSettings,
          project,
          yield* registry.getProviders,
        );
      }),
    runtimeMode: (mode, selection) =>
      registry.getProviders.pipe(
        Effect.map((providers) =>
          supportedRuntimeMode(
            mode,
            providers.find((p) => p.instanceId === selection.instanceId),
          ),
        ),
      ),
  });
});
export const layer = Layer.effect(ProjectLaunchDefaults, make);
