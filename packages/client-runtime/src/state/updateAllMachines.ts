export type MachineUpdateResult =
  | { readonly status: "succeeded"; readonly targetVersion: string }
  | { readonly status: "failed"; readonly message: string };

export type MachineUpdateState = MachineUpdateResult | { readonly status: "updating" };

export interface UpdateAllState {
  readonly remotes: Readonly<Record<string, MachineUpdateState>>;
  readonly local: "none" | "downloading" | "ready" | "installing" | "failed";
  readonly localError?: string;
}

export function canInstallLocal(state: UpdateAllState, localOnly = false): boolean {
  return (
    state.local === "ready" &&
    Object.values(state.remotes).every(
      (remote) => remote.status === "succeeded" || (localOnly && remote.status === "failed"),
    )
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Update failed.";
}

/** No bridge, RPC, or UI dependencies. Remote promises must settle only after
 * verified reconnect, terminal failure, or an interrupted timeout (never a
 * detached Promise.race that could still commit after the local client quits).
 */
export async function runUpdateAll<T extends { readonly environmentId: string }>(input: {
  readonly targets: ReadonlyArray<T>;
  readonly previous?: UpdateAllState;
  readonly updateRemote: (target: T) => Promise<MachineUpdateResult>;
  readonly prepareLocal?: () => Promise<void>;
  readonly installLocal: () => Promise<void>;
  readonly beforeInstall?: (state: UpdateAllState) => void;
  readonly onState: (state: UpdateAllState) => void;
  readonly localOnly?: boolean;
}): Promise<void> {
  let state: UpdateAllState = {
    remotes: {
      ...input.previous?.remotes,
      ...Object.fromEntries(
        input.targets.map((target) => [target.environmentId, { status: "updating" }]),
      ),
    },
    local: input.prepareLocal ? "downloading" : "none",
  };
  const publish = () => input.onState(state);
  publish();
  const remotes = input.targets.map(async (target) => {
    let result: MachineUpdateResult;
    try {
      result = await input.updateRemote(target);
    } catch (error) {
      result = { status: "failed", message: errorMessage(error) };
    }
    state = { ...state, remotes: { ...state.remotes, [target.environmentId]: result } };
    publish();
  });
  const local = input.prepareLocal
    ? Promise.resolve()
        .then(input.prepareLocal)
        .then(
          () => {
            state = { ...state, local: "ready" };
            publish();
          },
          (error) => {
            state = { ...state, local: "failed", localError: errorMessage(error) };
            publish();
          },
        )
    : undefined;
  await Promise.all([...remotes, local]);
  if (!canInstallLocal(state, input.localOnly)) return;
  state = { ...state, local: "installing" };
  publish();
  input.beforeInstall?.(state);
  // This call quits this client and its agent host. No required work follows it.
  return input.installLocal();
}

export interface UpdateConfirmationMachine {
  readonly serverLabel: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly runningThreadCount: number;
  readonly threadContinuation?: boolean;
  readonly continueThreadsAfterServerUpdate?: boolean;
}

export function updateAllConfirmation(
  machines: ReadonlyArray<UpdateConfirmationMachine>,
  order: "remote-first" | "remote-only" | "local-only" = "remote-first",
): string {
  const question =
    order === "local-only"
      ? "Install on this machine only?"
      : `Update T3 Code on ${machines.map((machine) => machine.serverLabel).join(", ")}?`;
  const restart =
    order === "local-only"
      ? "Remote failures will be skipped. This client will quit and relaunch."
      : order === "remote-only"
        ? "Remote machines update using their own update feeds. They close and relaunch on those machines."
        : "Remote machines update first using their own update feeds. This machine installs and relaunches last, after all remotes reconnect successfully. A remote failure blocks this machine's restart.";
  const summaries = machines
    .map(
      (machine) =>
        `${machine.serverLabel}: ${machine.fromVersion} → ${machine.targetVersion}; ${machine.runningThreadCount} running thread${machine.runningThreadCount === 1 ? "" : "s"}. ${machine.threadContinuation && machine.continueThreadsAfterServerUpdate ? "Running threads continue after restart." : "Running threads stop on restart."}`,
    )
    .join("\n");
  return `${question}\n\n${summaries}\n\n${restart}`;
}

export function updateAllLabel(
  remoteLabels: ReadonlyArray<string>,
  hasLocalUpdate: boolean,
): string | null {
  const count = remoteLabels.length + Number(hasLocalUpdate);
  if (count > 1) return `Update all (${count})`;
  return remoteLabels[0] ? `Update ${remoteLabels[0]}` : null;
}
