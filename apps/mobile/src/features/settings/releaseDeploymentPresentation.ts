import type { HostDeployment } from "@t3tools/contracts";
import { hostDeploymentStatusLabel } from "@t3tools/client-runtime/state/hostDeployments";

import type { StatusTone } from "../../components/StatusPill";

export function hostDeploymentTone(record: HostDeployment): StatusTone {
  const label = hostDeploymentStatusLabel(record);
  switch (record.status) {
    case "verified":
    case "accepted":
      return {
        label,
        pillClassName: "bg-adaptive-emerald-500-a12-a16",
        textClassName: "text-adaptive-emerald-700-300",
      };
    case "blocked":
      return { label, pillClassName: "bg-warning", textClassName: "text-warning-foreground" };
    case "failed":
      return { label, pillClassName: "bg-danger", textClassName: "text-danger-foreground" };
    case "cancelled":
      return { label, pillClassName: "bg-subtle", textClassName: "text-foreground-secondary" };
    case "preparing":
    case "waiting":
    case "installing":
      return { label, pillClassName: "bg-update", textClassName: "text-update-foreground" };
  }
}
