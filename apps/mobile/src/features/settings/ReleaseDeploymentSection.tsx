import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./components/SettingsSection";
import {
  hostDeploymentMilestones,
  latestHostDeployment,
} from "@t3tools/client-runtime/state/hostDeployments";
import { hostDeploymentTone } from "./releaseDeploymentPresentation";

/**
 * Read-only status of this host's latest approved release deployment.
 * Approval, admission and overrides stay on desktop. Render only for hosts
 * that advertise `hostDeployments` and grant orchestration read.
 */
export function ReleaseDeploymentSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const deployments = useEnvironmentQuery(
    serverEnvironment.deploymentsLive({ environmentId, input: {} }),
  );
  const record = latestHostDeployment(deployments.data?.deployments ?? []);
  if (!record) return null;

  return (
    <SettingsSection title="Release deployment">
      <View className="gap-2 p-4">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-base text-foreground">
            Version {record.request.version}
          </Text>
          <StatusPill {...hostDeploymentTone(record)} size="compact" />
        </View>
        {record.reason ? (
          <Text
            selectable
            className={cn(
              "text-sm",
              record.status === "failed" ? "text-danger-foreground" : "text-foreground-muted",
            )}
          >
            {record.reason}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-x-3 gap-y-1">
          {hostDeploymentMilestones(record).map((milestone) => (
            <View
              key={milestone.label}
              accessible
              accessibilityLabel={`${milestone.label}: ${milestone.reached ? "reached" : "not yet"}`}
              className="flex-row items-center gap-1"
            >
              <SymbolView
                name={milestone.reached ? "checkmark.circle" : "circle.dashed"}
                size={14}
                tintColorClassName={milestone.reached ? "accent-icon" : "accent-icon-muted"}
                type="monochrome"
              />
              <Text
                className={cn(
                  "text-xs",
                  milestone.reached ? "text-foreground" : "text-foreground-muted",
                )}
              >
                {milestone.label}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </SettingsSection>
  );
}
