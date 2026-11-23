import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import {
  HostCredentialSettings,
  readSourceControlHostSettings,
} from "@t3tools/source-control-core/shared/definition";
import type { ServerSettings, SourceControlProviderDiscoveryItem } from "@t3tools/contracts";

export {
  isMonochromeSourceControlIcon,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestLink,
  type ChangeRequestTerminology,
  type HostAccountChoice,
  type HostCredentialSettings,
  type ParsedChangeRequestUrl,
  type ReferenceAutolink,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
  type SourceControlIcon,
} from "@t3tools/source-control-core/shared/definition";

export const sourceControlClients = builtInSourceControlDefinitions;

export function projectGitHubAccountOptions(
  providers: ReadonlyArray<SourceControlProviderDiscoveryItem>,
): ReadonlyArray<string> {
  const github = providers.find((provider) => provider.kind === "github");
  const accounts = github?.status === "available" ? (github.auth.accounts ?? []) : [];
  return [
    ...new Set(
      accounts
        .filter(
          (entry) =>
            entry.host === "github.com" && entry.authenticated && !entry.environmentVariable,
        )
        .map((entry) => entry.account),
    ),
  ];
}

/** The saved per-hostname accounts and tokens of a host whose definition has `credentials`. */
export function readHostCredentialSettings(
  settings: Pick<ServerSettings, "sourceControlHosts">,
  kind: string,
): HostCredentialSettings {
  return readSourceControlHostSettings(HostCredentialSettings, settings.sourceControlHosts[kind]);
}

/** A host's change request term where it opens a sentence: "Merge request merged". */
export function capitalizeTerm(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}
