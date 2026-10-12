import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { environmentSession } from "../state/session";
import { environmentThreadShells } from "../state/threads";
import { savedServerUpdateTargets } from "../serverUpdateTargets";

export function useServerUpdateTargets(targetVersion: string, desktopOnly = false) {
  const { environments } = useEnvironments();
  const statesAtom = useMemo(
    () =>
      Atom.make((get) =>
        environments.map((environment) => {
          const session = get(environmentSession.sessionStateAtom(environment.environmentId));
          return {
            environment,
            updateStatus: get(serverEnvironment.updateStateAtom(environment.environmentId)).status,
            session: session._tag === "Success" ? session.value : null,
            runningThreadCount: get(
              environmentThreadShells.environmentThreadsAtom(environment.environmentId),
            ).filter((thread) => ["preparing", "starting", "running"].includes(thread.status))
              .length,
          };
        }),
      ),
    [environments],
  );
  return savedServerUpdateTargets(useAtomValue(statesAtom), targetVersion, desktopOnly);
}
