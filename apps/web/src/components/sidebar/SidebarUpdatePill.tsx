import type { DesktopUpdateState } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { useUpdateAllMachines } from "../../hooks/useUpdateAllMachines";
import { useReleaseDeployment } from "../../hooks/useReleaseDeployment";
import {
  ReleaseAcceptanceDialog,
  ReleaseApprovalDialog,
  ReleaseDeploymentDetails,
} from "../ReleaseDeployment";
import { Button } from "../ui/button";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
} from "../desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DesktopUpdateStatusIcon,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

export function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return showUpdateDetails && state?.channel === "nightly" && state.releaseNotes.length > 0;
}

export function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  // The trigger is the update action, so its presses must not also toggle the Popover.
  if (details.reason === "trigger-press") details.cancel();
}

export function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { readonly key: string; readonly shiftKey: boolean },
  handle: Pick<SidebarUpdatePopoverHandle, "open">,
  triggerId: string,
): void {
  if (event.key !== "Tab" || event.shiftKey) return;
  // Hover-open popovers do not manage focus. Promote this one before native Tab runs.
  flushSync(() => handle.open(triggerId));
}

function resolveSidebarUpdatePresentation({
  action,
  isDownloading,
  showCheckIcon,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly isDownloading: boolean;
  readonly showCheckIcon: boolean;
}) {
  const showUpdateDetails = action !== "none" || isDownloading;
  const iconStatus = showCheckIcon
    ? "checking"
    : action === "install"
      ? "downloaded"
      : isDownloading
        ? "downloading"
        : action === "download"
          ? "available"
          : "idle";

  return {
    iconStatus,
    showUpdateDetails,
    showUpdateIconState: showUpdateDetails && !showCheckIcon,
  } as const;
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

export function SidebarUpdatePill() {
  return isElectron ? <SidebarUpdateControl /> : null;
}

export function SidebarMachineUpdateDetails({
  machines,
  state,
  tooltip,
  pinnedRelease = false,
}: {
  readonly machines: ReturnType<typeof useUpdateAllMachines>;
  readonly state: DesktopUpdateState | null;
  readonly tooltip: string;
  /** The approved-release path pins one version instead of following each feed. */
  readonly pinnedRelease?: boolean;
}) {
  return (
    <div className="flex max-w-80 flex-col gap-2 text-xs">
      <p className="font-medium">{tooltip}</p>
      {machines.hasLocalUpdate && state ? (
        <p>
          This machine: {state.currentVersion} → {state.downloadedVersion ?? state.availableVersion}{" "}
          ({machines.run?.local ?? state.status})
        </p>
      ) : null}
      {machines.targets.map((target) => {
        const result = machines.run?.remotes[target.environmentId];
        return (
          <div key={target.environmentId}>
            <p>
              {target.serverLabel}: {target.fromVersion} →{" "}
              {result?.status === "succeeded" ? result.targetVersion : target.targetVersion} (
              {result?.status ?? "available"})
            </p>
            {result?.status === "failed" ? (
              <div role="alert">
                <p>{result.message}</p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={machines.pending}
                  onClick={() => void machines.start(target.environmentId)}
                >
                  Retry {target.serverLabel}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      {machines.run?.localError ? <p role="alert">{machines.run.localError}</p> : null}
      {machines.hasLocalUpdate &&
      machines.run &&
      (machines.run.local === "failed" ||
        Object.values(machines.run.remotes).some((remote) => remote.status === "failed")) ? (
        <Button
          size="xs"
          variant="outline"
          disabled={machines.pending}
          onClick={() => void machines.start(undefined, true)}
        >
          Install on this machine only
        </Button>
      ) : null}
      <p>
        {pinnedRelease
          ? "Approve the release to install it on each machine, remotes first."
          : "Remote update feeds decide their installed versions."}
      </p>
    </div>
  );
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const machines = useUpdateAllMachines(state);
  const deployment = useReleaseDeployment(state, machines.hasLocalUpdate);
  const deploymentActive = deployment.request !== null;
  const hasMachineDetails =
    deploymentActive || machines.targets.length > 0 || machines.run !== null;
  const machinesPending = machines.pending || deployment.preparing;
  const [isActionPending, setIsActionPending] = useState(false);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(false);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  useEffect(() => {
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (state?.status === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }, [prefersReducedMotion, state?.status]);

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking",
    prefersReducedMotion,
  });
  const { iconStatus, showUpdateDetails, showUpdateIconState } = resolveSidebarUpdatePresentation({
    action,
    isDownloading,
    showCheckIcon,
  });
  const tooltip = deployment.summary
    ? deployment.summary
    : machines.pending
      ? "Updating machines…"
      : machines.run &&
          Object.values(machines.run.remotes).some((remote) => remote.status === "failed")
        ? "Machine update failed"
        : (machines.label ??
          (showUpdateDetails
            ? state
              ? getDesktopUpdateButtonTooltip(state)
              : "Update available"
            : showCheckIcon
              ? "Checking for updates…"
              : "Check for updates"));
  const disabled = hasMachineDetails
    ? machinesPending
    : showCheckIcon
      ? true
      : showUpdateDetails
        ? isDesktopUpdateButtonDisabled(state)
        : !canCheckForUpdate(state);
  const isInteractionDisabled = disabled || isActionPending || machinesPending;
  const showReleaseNotesPopover =
    hasMachineDetails || shouldUseSidebarUpdateReleaseNotesPopover(showUpdateDetails, state);

  useEffect(() => {
    if (!showReleaseNotesPopover) {
      releaseNotesPopoverHandle.close();
      return;
    }

    const trigger = document.getElementById(releaseNotesTriggerId);
    if (trigger?.matches(":focus-visible")) {
      releaseNotesPopoverHandle.open(releaseNotesTriggerId);
    }
  }, [releaseNotesPopoverHandle, releaseNotesTriggerId, showReleaseNotesPopover]);

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || (!state && !hasMachineDetails)) return;
    if (isInteractionDisabled) return;

    setIsActionPending(true);

    if (deploymentActive) {
      // A release is already approved; the popover is where it is managed.
      setIsActionPending(false);
      releaseNotesPopoverHandle.open(releaseNotesTriggerId);
      return;
    }

    if (action !== "none" || isDownloading || hasMachineDetails) {
      setIsActionPending(false);
      if (deployment.eligible) await deployment.beginApproval();
      else await machines.start();
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      })
      .finally(() => setIsActionPending(false));
  }, [
    action,
    deployment,
    deploymentActive,
    isDownloading,
    hasMachineDetails,
    isInteractionDisabled,
    machines,
    prefersReducedMotion,
    releaseNotesPopoverHandle,
    releaseNotesTriggerId,
    state,
  ]);

  const handleCheckAnimationIteration = useCallback(() => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking",
        prefersReducedMotion,
      }),
    );
  }, [prefersReducedMotion, state?.status]);

  const updateButton = (
    <button
      type="button"
      aria-label={tooltip}
      aria-disabled={isInteractionDisabled || undefined}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
        showUpdateIconState || hasMachineDetails
          ? cn(
              "bg-sidebar-control-surface text-sidebar-foreground",
              !isInteractionDisabled && "hover:bg-sidebar-row-hover",
            )
          : cn(
              "text-(--sidebar-icon-color)",
              !isInteractionDisabled && "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            ),
        disabled && !showUpdateIconState && "opacity-60",
      )}
      onClick={handleAction}
      onBlur={() => {
        suppressReleaseNotesFocusOpen.current = false;
      }}
      onFocus={(event) => {
        if (!showReleaseNotesPopover || !event.currentTarget.matches(":focus-visible")) return;
        if (suppressReleaseNotesFocusOpen.current) {
          suppressReleaseNotesFocusOpen.current = false;
          return;
        }
        flushSync(() => releaseNotesPopoverHandle.open(releaseNotesTriggerId));
      }}
      onKeyDown={(event) => {
        if (!showReleaseNotesPopover) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(
          event,
          releaseNotesPopoverHandle,
          releaseNotesTriggerId,
        );
      }}
    >
      <DesktopUpdateStatusIcon
        key={showCheckIcon ? checkAnimationKey : iconStatus}
        downloadPercent={state?.downloadPercent ?? null}
        isCheckAnimating={showCheckIcon && !prefersReducedMotion}
        onCheckAnimationIteration={handleCheckAnimationIteration}
        status={
          hasMachineDetails
            ? machines.pending || deployment.running
              ? "downloading"
              : "available"
            : iconStatus
        }
      />
    </button>
  );

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Popover
        handle={releaseNotesPopoverHandle}
        onOpenChange={(open, details) => {
          if (open && !showReleaseNotesPopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
        }}
      >
        <Tooltip disabled={showReleaseNotesPopover}>
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              <PopoverTrigger
                {...(!showReleaseNotesPopover
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={releaseNotesPopoverHandle}
                id={releaseNotesTriggerId}
                openOnHover={showReleaseNotesPopover}
                render={updateButton}
              />
            }
          />
          {!showReleaseNotesPopover ? (
            <TooltipPopup
              align="center"
              side="top"
              variant={showUpdateDetails ? "glass" : "default"}
            >
              {tooltip}
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover ? (
          <PopoverPopup
            align="center"
            aria-label={hasMachineDetails ? "Machine updates" : "Nightly update release notes"}
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                releaseNotesPopupRef.current?.contains(document.activeElement)
              ) {
                suppressReleaseNotesFocusOpen.current = true;
              }
            }}
            ref={releaseNotesPopupRef}
            side="top"
            tooltipStyle
          >
            {deploymentActive ? (
              <ReleaseDeploymentDetails deployment={deployment} />
            ) : hasMachineDetails ? (
              <SidebarMachineUpdateDetails
                machines={machines}
                pinnedRelease={deployment.eligible}
                state={state}
                tooltip={tooltip}
              />
            ) : null}
            {state && shouldUseSidebarUpdateReleaseNotesPopover(showUpdateDetails, state) ? (
              <SidebarUpdateReleaseNotes
                shell={window.desktopBridge}
                state={state}
                tooltip={tooltip}
              />
            ) : null}
          </PopoverPopup>
        ) : null}
      </Popover>
      {deployment.approval ? (
        <ReleaseApprovalDialog
          approval={deployment.approval}
          onApprove={(scope) => void deployment.approve(scope)}
          onCancel={deployment.dismissApproval}
        />
      ) : null}
      {deployment.acceptance ? (
        <ReleaseAcceptanceDialog
          target={deployment.acceptance}
          onSubmit={deployment.recordAcceptance}
          onCancel={deployment.dismissAcceptance}
        />
      ) : null}
    </SidebarMenuItem>
  );
}
