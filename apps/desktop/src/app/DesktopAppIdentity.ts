import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import { resolveCommitHash } from "./appCommitHash.ts";

export class DesktopAppIdentity extends Context.Service<
  DesktopAppIdentity,
  {
    readonly resolveUserDataPath: Effect.Effect<
      string,
      DesktopUserData.DesktopUserDataInitializationError
    >;
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppIdentity") {}

/** @public */
export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const userDataContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const commitHashCache = yield* Ref.make<Option.Option<Option.Option<string>>>(Option.none());

  const resolveAboutCommitHash = Effect.gen(function* () {
    const cached = yield* Ref.get(commitHashCache);
    if (Option.isSome(cached)) {
      return cached.value;
    }
    const commitHash = yield* resolveCommitHash.pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    yield* Ref.set(commitHashCache, Option.some(commitHash));
    return commitHash;
  });

  const userDataPath = DesktopUserData.resolveUserDataPath(environment).pipe(
    Effect.provide(userDataContext),
  );

  const configure = Effect.gen(function* () {
    const commitHash = yield* resolveAboutCommitHash;
    // Electron strips spaces but keeps parentheses in its User-Agent token, breaking Turnstile in preview sessions.
    yield* electronApp.setName(
      `${environment.branding.baseName} ${environment.branding.stageLabel}`,
    );
    yield* electronApp.setAboutPanelOptions({
      applicationName: environment.displayName,
      applicationVersion: environment.appVersion,
      version: Option.getOrElse(commitHash, () => "unknown"),
    });

    if (environment.platform === "win32") {
      yield* electronApp.setAppUserModelId(environment.appUserModelId);
    }

    // Packaged bundles carry their icon in Info.plist; setting it again overwrites the user's custom icon.
    if (environment.platform === "darwin" && !environment.isPackaged) {
      const iconPaths = yield* assets.iconPaths;
      yield* Option.match(iconPaths.png, {
        onNone: () => Effect.void,
        onSome: electronApp.setDockIcon,
      });
    }
  }).pipe(Effect.withSpan("desktop.appIdentity.configure"));

  return DesktopAppIdentity.of({
    resolveUserDataPath: userDataPath,
    configure,
  });
});

export const layer = Layer.effect(DesktopAppIdentity, make);
