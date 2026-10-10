import type { EnvironmentId, ForkUpdateInstallInput, ForkUpdateStatus } from "@t3tools/contracts";

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
  /** Frozen identity sent to every pending destination. Null while installing or conflicted. */
  readonly target: ForkUpdateInstallInput | null;
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
  if (installing.length > 0) {
    const targetVersion = installing[0]!.status.installingVersion!;
    return {
      pending: [],
      installing,
      targetVersion,
      target: null,
      tooltip: `Installing fork ${shortForkVersion(targetVersion)} on ${listLabels(installing)} once running turns finish`,
    };
  }
  const buildNumber = (version: string | null) =>
    Number(/-nick\.(\d+)$/.exec(version ?? "")?.[1] ?? -1);
  const releases = supported
    .flatMap((machine) => (machine.status.latest ? [machine.status.latest] : []))
    .toSorted((left, right) => buildNumber(right.version) - buildNumber(left.version));
  const target = releases[0];
  if (!target) return null;
  if (
    supported.some(
      (machine) => buildNumber(machine.status.installedVersion) > buildNumber(target.version),
    )
  ) {
    return {
      pending: [],
      installing: [],
      targetVersion: target.version,
      target: null,
      tooltip:
        "A machine has a newer fork build than the available release information. Refresh before updating.",
    };
  }
  const pending = supported
    .filter((machine) => buildNumber(machine.status.installedVersion) < buildNumber(target.version))
    .toSorted((left, right) => Number(left.isPrimary) - Number(right.isPrimary));
  if (pending.length === 0) return null;
  if (
    releases.some(
      (release) =>
        buildNumber(release.version) === buildNumber(target.version) &&
        (release.version !== target.version || release.commit !== target.commit),
    )
  ) {
    return {
      pending: [],
      installing: [],
      targetVersion: target.version,
      target: null,
      tooltip: "Fork release information differs across machines. Refresh before updating.",
    };
  }

  const targetVersion = target.version;
  const tooltip = `Fork ${shortForkVersion(targetVersion)} is available for ${listLabels(pending)}. Update ${pending.length === 1 ? "it" : "all"}`;
  return {
    pending,
    installing,
    targetVersion,
    target: { version: target.version, commit: target.commit },
    tooltip,
  };
}

export function forkUpdateConfirmationMessage(view: ForkUpdatePillView): string {
  const lines = view.pending.map(
    (machine) =>
      `${machine.label}: ${shortForkVersion(machine.status.installedVersion ?? "unknown")} -> ${shortForkVersion(
        view.targetVersion,
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
