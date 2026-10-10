// @effect-diagnostics nodeBuiltinImport:off -- Breadcrumbs must reach disk synchronously to survive a stalled or killed quit.
// @effect-diagnostics globalDate:off -- Breadcrumbs are written outside any Effect fiber, from signal and quit handlers.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * Shutdown breadcrumbs, appended synchronously to `desktop-shutdown.log` so
 * they survive a stalled or killed quit. Spans only reach the trace when they
 * end, which a hung shutdown never does.
 */
let shutdownLogPath: string | null = null;

export function configureShutdownLog(logDir: string): void {
  shutdownLogPath = NodePath.join(logDir, "desktop-shutdown.log");
}

export function shutdownBreadcrumb(message: string): void {
  if (shutdownLogPath === null) return;
  try {
    NodeFS.appendFileSync(shutdownLogPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // A missing log is no reason to disturb the quit.
  }
}

/**
 * Runs `effect` with breadcrumbs around the teardown of everything it adds to
 * the current scope: "releasing" when that teardown starts, "released" once it
 * has finished. A label with no "released" line names the stalled resource.
 */
export const traceTeardown = Effect.fnUntraced(function* <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, R | Scope.Scope> {
  yield* Effect.addFinalizer(() => Effect.sync(() => shutdownBreadcrumb(`${label}: released`)));
  const result = yield* effect;
  yield* Effect.addFinalizer(() => Effect.sync(() => shutdownBreadcrumb(`${label}: releasing`)));
  return result;
});
