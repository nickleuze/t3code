import type { EnvironmentId, ForkUpdateStatus } from "@t3tools/contracts";

/** Fork-only: one machine running a fork desktop build. */
export interface ForkUpdateMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The machine this window runs on; it restarts last. */
  readonly isPrimary: boolean;
  readonly status: ForkUpdateStatus;
}

export interface ForkUpdatePillView {
  /** Machines behind the newest release, remote machines first. */
  readonly pending: ReadonlyArray<ForkUpdateMachine>;
  readonly installing: ReadonlyArray<ForkUpdateMachine>;
  readonly targetVersion: string;
  readonly tooltip: string;
}

/** "0.0.44-nick.6" -> "nick.6". */
export function shortForkVersion(version: string): string {
  const separator = version.indexOf("-");
  return separator === -1 ? version : version.slice(separator + 1);
}

function listLabels(machines: ReadonlyArray<ForkUpdateMachine>): string {
  return machines.map((machine) => machine.label).join(", ");
}

export function resolveForkUpdatePillView(
  machines: ReadonlyArray<ForkUpdateMachine>,
): ForkUpdatePillView | null {
  const supported = machines.filter((machine) => machine.status.supported);
  const installing = supported.filter((machine) => machine.status.installingVersion !== null);
  const pending = supported
    .filter(
      (machine) => machine.status.updateAvailable && machine.status.installingVersion === null,
    )
    .toSorted((left, right) => Number(left.isPrimary) - Number(right.isPrimary));
  if (pending.length === 0 && installing.length === 0) return null;

  const targetVersion =
    installing[0]?.status.installingVersion ?? pending[0]?.status.latest?.version ?? "";
  const target = shortForkVersion(targetVersion);
  const tooltip =
    pending.length > 0
      ? `Fork ${target} is available for ${listLabels(pending)}. Update ${
          pending.length === 1 ? "it" : "all"
        }`
      : `Installing fork ${target} on ${listLabels(installing)} once running turns finish`;
  return { pending, installing, targetVersion, tooltip };
}

export function forkUpdateConfirmationMessage(view: ForkUpdatePillView): string {
  const lines = view.pending.map(
    (machine) =>
      `${machine.label}: ${shortForkVersion(machine.status.installedVersion ?? "unknown")} -> ${shortForkVersion(
        machine.status.latest?.version ?? view.targetVersion,
      )}`,
  );
  return [
    `Update T3 Code to fork ${shortForkVersion(view.targetVersion)}?`,
    "",
    ...lines,
    "",
    "Each machine lets its running turns finish, pauses active goals, then restarts T3 Code and resumes them. This machine restarts last.",
  ].join("\n");
}
