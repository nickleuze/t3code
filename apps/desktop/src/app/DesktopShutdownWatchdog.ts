import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as DesktopShutdown from "./DesktopShutdown.ts";
import { shutdownBreadcrumb } from "./DesktopShutdownLog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

/**
 * Teardown can stall before its finalizer stops the backends. The independent
 * exit deadline must also survive a stalled emergency backend stop.
 * The callback belongs to the app, which owns the complete backend pool.
 */
export const watchShutdown = Effect.fn("desktop.app.shutdownWatchdog")(function* <R>(
  stopBackends: () => Effect.Effect<void, never, R>,
) {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const electronApp = yield* ElectronApp.ElectronApp;
  const recover = Effect.gen(function* () {
    yield* Effect.sleep(Duration.seconds(20));
    if (yield* shutdown.isComplete) return;
    shutdownBreadcrumb("shutdown stalled; stopping backends directly");
    yield* stopBackends();
    shutdownBreadcrumb("backends stopped by the watchdog");
    yield* shutdown.markComplete;
  });
  const exit = Effect.gen(function* () {
    yield* Effect.sleep(Duration.seconds(30));
    shutdownBreadcrumb("app did not exit after shutdown; exiting");
    yield* electronApp.exit(0);
  });
  // In the real app exit terminates the process. In tests it completes the
  // deadline and interrupts any still-stalled recovery fiber.
  yield* Effect.raceFirst(exit, recover.pipe(Effect.andThen(Effect.never)));
});
