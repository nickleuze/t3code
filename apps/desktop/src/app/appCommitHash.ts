import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;

const AppPackageMetadata = Schema.Struct({
  t3codeCommitHash: Schema.optional(Schema.String),
});
const decodeAppPackageMetadata = Schema.decodeEffect(Schema.fromJsonString(AppPackageMetadata));

const normalizeCommitHash = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return COMMIT_HASH_PATTERN.test(trimmed)
    ? Option.some(trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase())
    : Option.none();
};

/** Commit stamped into a packaged build, honoring the environment override. */
export const resolveCommitHash: Effect.Effect<
  Option.Option<string>,
  never,
  DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem
> = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const override = Option.flatMap(environment.commitHashOverride, normalizeCommitHash);
  if (Option.isSome(override) || !environment.isPackaged) return override;
  const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
  const raw = yield* fileSystem.readFileString(packageJsonPath).pipe(Effect.option);
  return yield* Option.match(raw, {
    onNone: () => Effect.succeed(Option.none<string>()),
    onSome: (value) =>
      decodeAppPackageMetadata(value).pipe(
        Effect.map((parsed) =>
          Option.fromNullishOr(parsed.t3codeCommitHash).pipe(Option.flatMap(normalizeCommitHash)),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
  });
});
