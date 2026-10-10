import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopShutdown from "./DesktopShutdown.ts";
import { watchShutdown } from "./DesktopShutdownWatchdog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

it.effect("stalled resource cleanup stops backends and allows the quit to finish", () =>
  Effect.gen(function* () {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const stopped = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<number>();
    const fiber = yield* watchShutdown(() =>
      Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
    ).pipe(
      Effect.provide(
        Layer.mock(ElectronApp.ElectronApp)({
          exit: (code) => Deferred.succeed(exited, code).pipe(Effect.asVoid),
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("20 seconds");
    yield* Deferred.await(stopped);
    yield* shutdown.awaitComplete;
    yield* TestClock.adjust("10 seconds");
    assert.strictEqual(yield* Deferred.await(exited), 0);
    yield* Fiber.join(fiber);
  }).pipe(Effect.provide(DesktopShutdown.layer)),
);

it.effect("a stalled emergency backend stop cannot stall the independent exit deadline", () =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<number>();
    const fiber = yield* watchShutdown(() => Effect.never).pipe(
      Effect.provide(
        Layer.mock(ElectronApp.ElectronApp)({
          exit: (code) => Deferred.succeed(exited, code).pipe(Effect.asVoid),
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("30 seconds");
    assert.strictEqual(yield* Deferred.await(exited), 0);
    yield* Fiber.join(fiber);
  }).pipe(Effect.provide(DesktopShutdown.layer)),
);

it.effect("already completed shutdown leaves backends alone", () =>
  Effect.gen(function* () {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    yield* shutdown.markComplete;
    const fiber = yield* watchShutdown(() => Effect.die("backend stop must not run")).pipe(
      Effect.provide(Layer.mock(ElectronApp.ElectronApp)({ exit: () => Effect.void })),
      Effect.forkChild,
    );
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.join(fiber);
  }).pipe(Effect.provide(DesktopShutdown.layer)),
);
