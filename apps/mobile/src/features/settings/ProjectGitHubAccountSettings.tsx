import { AuthSettingsWriteScope, projectGitHubAccountOptions } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useGT } from "gt-react-native";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { ProjectGitHubAccountChoices } from "../projects/ProjectGitHubAccountChoices";
import { SettingsSection } from "./components/SettingsSection";
import type { SettingsTarget } from "./settings-environment-filter";
import {
  managedSettingReason,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

export function ProjectGitHubAccountSettings(props: {
  readonly members: readonly EnvironmentProject[];
  readonly environments: readonly SettingsTarget[];
}) {
  const gt = useGT();
  const targets = resolveMobileSettingsTargets(props.environments, props.members);
  const reference = targets[0];
  const environmentId =
    reference &&
    targets.every(
      (target) => target.environment.environmentId === reference.environment.environmentId,
    )
      ? reference.environment.environmentId
      : null;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const accounts = projectGitHubAccountOptions(discovery.data?.sourceControlProviders ?? []);
  const value = uniformMobileSetting(targets, "githubAccount");
  const mixed = targets.some(
    (target) => target.settings.githubAccount !== reference?.settings.githubAccount,
  );
  const managed = managedSettingReason(targets, ["githubAccount", "projectSettingsOverrides"]);
  const [saving, setSaving] = useState(false);
  const writeSettings = useSettingsWriter();

  const save = async (githubAccount: string | null) => {
    if (
      saving ||
      managed !== undefined ||
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthSettingsWriteScope) ||
      (!mixed && value === githubAccount)
    )
      return;
    setSaving(true);
    await writeSettings(
      targets,
      planMobileScopedSettingsPatch(targets, true, { githubAccount }),
    ).finally(() => setSaving(false));
  };

  return (
    <SettingsSection title={gt("GitHub account")}>
      <ProjectGitHubAccountChoices
        accounts={accounts}
        value={value}
        mixed={mixed || environmentId === null}
        disabled={!canWrite || saving || managed !== undefined}
        description={
          managed ??
          (environmentId === null
            ? gt("Select one environment to choose an account signed in there.")
            : gt("Use the environment account for github.com pull requests."))
        }
        onChange={(account) => void save(account)}
      />
    </SettingsSection>
  );
}
