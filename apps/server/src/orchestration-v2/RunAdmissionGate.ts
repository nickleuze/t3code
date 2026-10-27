import type { OrchestrationV2DomainEvent, OrchestrationV2RunStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** Statuses that hold a host busy; matches `isBlockingRun` and `fork/update.sh`. */
const BLOCKING_RUN_STATUSES: ReadonlyArray<OrchestrationV2RunStatus> = [
  "preparing",
  "starting",
  "running",
  "waiting",
];

export class RunAdmissionClosedError extends Schema.TaggedError<RunAdmissionClosedError>()(
  "RunAdmissionClosedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Whether a failure, or any cause it wraps, is a gate rejection. */
export function isRunAdmissionClosed(cause: unknown): boolean {
  const seen = new Set<unknown>();
  let current = cause;
  while (Predicate.isObject(current) && !seen.has(current)) {
    if (current._tag === "RunAdmissionClosedError") return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

export interface BlockingRun {
  readonly threadId: string;
  readonly runId: string;
}

export interface RunAdmissionGateShape {
  /**
   * Close the gate only if no run is blocking. The check and the close happen
   * inside one write transaction, so no commit can admit a run in between.
   */
  readonly closeWhenIdle: (
    reason: string,
  ) => Effect.Effect<
    | { readonly closed: true }
    | { readonly closed: false; readonly blocking: ReadonlyArray<BlockingRun> },
    SqlError
  >;
  readonly open: Effect.Effect<void>;
  readonly closedReason: Effect.Effect<string | undefined>;
  /**
   * Called by the event sink inside every write transaction. While closed, any
   * event that puts a run in a blocking status is a new admission: the gate
   * only closes at zero blocking runs, so no existing run can produce one.
   */
  readonly guard: (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<void, RunAdmissionClosedError>;
}

/**
 * Host-wide gate on new run admission, held briefly while a release
 * deployment backs up state and commits its native update. In memory only:
 * a fresh process always starts open, so a crash can never leave a host
 * unable to start work.
 */
export class RunAdmissionGate extends Context.Service<RunAdmissionGate, RunAdmissionGateShape>()(
  "t3/orchestration-v2/RunAdmissionGate",
) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const closed = yield* Ref.make<string | undefined>(undefined);

  const closeWhenIdle: RunAdmissionGateShape["closeWhenIdle"] = (reason) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const blocking = yield* sql<{ readonly thread_id: string; readonly run_id: string }>`
          SELECT thread_id, run_id
          FROM orchestration_v2_projection_runs
          WHERE status IN ${sql.in(BLOCKING_RUN_STATUSES)}
        `;
        if (blocking.length > 0) {
          return {
            closed: false as const,
            blocking: blocking.map((row) => ({ threadId: row.thread_id, runId: row.run_id })),
          };
        }
        yield* Ref.set(closed, reason);
        return { closed: true as const };
      }),
    );

  const guard: RunAdmissionGateShape["guard"] = Effect.fn("RunAdmissionGate.guard")(
    function* (events) {
      const reason = yield* Ref.get(closed);
      if (reason === undefined) return;
      const admits = events.some(
        (event) =>
          (event.type === "run.created" || event.type === "run.updated") &&
          BLOCKING_RUN_STATUSES.includes(event.payload.status),
      );
      if (admits) return yield* new RunAdmissionClosedError({ reason });
    },
  );

  return RunAdmissionGate.of({
    closeWhenIdle,
    open: Ref.set(closed, undefined),
    closedReason: Ref.get(closed),
    guard,
  });
});

export const layer = Layer.effect(RunAdmissionGate, make);
