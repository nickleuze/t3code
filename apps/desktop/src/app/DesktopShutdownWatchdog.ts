import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as DesktopShutdown from "./DesktopShutdown.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

const { logWarning } = makeComponentLogger("desktop-shutdown-watchdog");

/**
 * Bounds a requested shutdown. Teardown can stall before its finalizer stops
 * the backends, so after 20s the watchdog stops them itself and completes the
 * shutdown; an independent 30s deadline exits even if that stop stalls too.
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
    yield* logWarning("shutdown stalled; stopping backends directly");
    yield* stopBackends();
    yield* shutdown.markComplete;
  });
  const exit = Effect.gen(function* () {
    yield* Effect.sleep(Duration.seconds(30));
    yield* logWarning("app did not exit after shutdown; exiting");
    // Non-zero, so a supervisor sees that the quit had to be forced.
    yield* electronApp.exit(1);
  });
  // In the real app exit terminates the process. In tests it completes the
  // deadline and interrupts any still-stalled recovery fiber.
  yield* Effect.raceFirst(exit, recover.pipe(Effect.andThen(Effect.never)));
});
