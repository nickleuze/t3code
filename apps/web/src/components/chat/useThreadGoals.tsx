import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  goalComposerPlaceholder,
  goalIsEditable,
  goalIsLive,
  resolveGoalComposerIntent,
  type GoalControlAction,
} from "@t3tools/client-runtime/state/thread-goals";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type OrchestrationV2GoalProposal,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { randomUUID } from "~/lib/utils";
import { useEnvironmentScope } from "~/state/session";
import { useThreadProjection } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { goalBannerItem, goalIterationBannerItem, goalProposalBannerItem } from "./GoalBanner";
import { GoalDialog, type GoalBrief } from "./GoalDialog";

type GoalSendRoute =
  | { readonly kind: "send"; readonly text: string }
  | { readonly kind: "reply"; readonly goalId: CommandId; readonly text: string }
  | { readonly kind: "handled" };

/**
 * Everything a thread's chat view needs for `/t3-goal`: composer banners,
 * the brief dialog, and routing of sends to the goal while it is live.
 */
export function useThreadGoals(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell | null;
  readonly supportsGoals: boolean;
  readonly isServerThread: boolean;
  readonly isSubagent: boolean;
}): {
  readonly commandAvailable: boolean;
  readonly placeholder: string | undefined;
  readonly bannerItems: readonly ComposerBannerStackItem[];
  readonly dialog: ReactNode;
  /** Where a composer send goes: an ordinary turn (maybe rewritten), a goal reply, or nowhere. */
  readonly routeSend: (text: string, hasNonTextContent: boolean) => GoalSendRoute;
  /** Sends a goal reply; false when it failed (already reported) or one is in flight. */
  readonly sendReply: (reply: Extract<GoalSendRoute, { kind: "reply" }>) => Promise<boolean>;
} {
  const { environmentId, thread, supportsGoals } = input;
  const navigate = useNavigate();
  const canMutate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const setGoal = useAtomCommand(threadEnvironment.setGoal, { reportFailure: false });
  const controlGoal = useAtomCommand(threadEnvironment.controlGoal, { reportFailure: false });
  const messageGoal = useAtomCommand(threadEnvironment.messageGoal, { reportFailure: false });
  const updateGoal = useAtomCommand(threadEnvironment.updateGoal, { reportFailure: false });
  const dismissProposal = useAtomCommand(threadEnvironment.dismissGoalProposal, {
    reportFailure: false,
  });
  // Edits either the agent's proposal before it starts, or a paused or blocked goal's brief.
  const [editing, setEditing] = useState<
    | { readonly threadId: ThreadId; readonly proposal: OrchestrationV2GoalProposal }
    | { readonly threadId: ThreadId; readonly proposal: null }
    | null
  >(null);
  const replying = useRef(false);

  const threadId = thread?.id ?? null;
  const goal = supportsGoals ? (thread?.t3Goal ?? null) : null;
  const proposal = supportsGoals ? (thread?.goalProposal ?? null) : null;
  const iteration = supportsGoals ? (thread?.goalIteration ?? null) : null;
  const liveGoal = goal !== null && goalIsLive(goal) ? goal : null;
  const canEditGoal = goal !== null && goalIsEditable(goal) && canMutate;
  // The shell summary lacks the brief, so editing reads the full goal.
  const fullGoal =
    useThreadProjection(
      editing?.proposal === null && threadId !== null
        ? scopeThreadRef(environmentId, threadId)
        : null,
    )?.projection.thread.goal ?? null;
  const commandAvailable =
    supportsGoals && canMutate && input.isServerThread && iteration === null && !input.isSubagent;

  const openThread = useCallback(
    (target: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, target)),
      }),
    [environmentId, navigate],
  );
  const startGoal = useCallback(
    async (brief: GoalBrief | OrchestrationV2GoalProposal) => {
      if (threadId === null) throw new Error("T3 goals are unavailable in this thread.");
      const result = await setGoal({
        environmentId,
        input: {
          type: "thread.goal.set",
          commandId: CommandId.make(randomUUID()),
          threadId,
          objective: brief.objective,
          doneWhen: brief.doneWhen,
          background: brief.background,
          permissions: brief.permissions,
          checkCommand: brief.checkCommand,
          ...(brief.iterationTimeoutMins === null
            ? {}
            : { iterationTimeoutMins: brief.iterationTimeoutMins }),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    [environmentId, setGoal, threadId],
  );

  const bannerItems = useMemo(() => {
    if (threadId === null) return [];
    const items: ComposerBannerStackItem[] = [];
    if (goal !== null) {
      items.push(
        goalBannerItem({
          goal,
          canControl: canMutate,
          onControl: async (action: GoalControlAction) => {
            const result = await controlGoal({
              environmentId,
              input: {
                type: "thread.goal.control",
                commandId: CommandId.make(randomUUID()),
                threadId,
                goalId: goal.id,
                action,
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
          onOpenIteration: openThread,
          onEdit: canEditGoal ? () => setEditing({ threadId, proposal: null }) : null,
        }),
      );
    }
    if (proposal !== null && liveGoal === null) {
      items.push(
        goalProposalBannerItem({
          proposal,
          canStart: commandAvailable,
          canDismiss: canMutate,
          onStart: () => startGoal(proposal),
          onEdit: () => setEditing({ threadId, proposal }),
          onDismiss: async () => {
            const result = await dismissProposal({
              environmentId,
              input: {
                type: "thread.goal.proposal.dismiss",
                commandId: CommandId.make(randomUUID()),
                threadId,
                proposalId: proposal.id,
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        }),
      );
    }
    if (iteration !== null) items.push(goalIterationBannerItem(iteration, openThread));
    return items;
  }, [
    canEditGoal,
    canMutate,
    commandAvailable,
    controlGoal,
    dismissProposal,
    environmentId,
    goal,
    iteration,
    liveGoal,
    openThread,
    proposal,
    startGoal,
    threadId,
  ]);

  const routeSend = useCallback(
    (text: string, hasNonTextContent: boolean): GoalSendRoute => {
      const intent = resolveGoalComposerIntent({
        text,
        goal: liveGoal,
        supportsGoals,
        canMutate,
        isIteration: iteration !== null,
        isSubagent: input.isSubagent,
        hasNonTextContent,
      });
      if (intent.kind === "blocked") {
        toastManager.add(stackedThreadToast({ type: "info", title: intent.reason }));
        return { kind: "handled" };
      }
      return intent.kind === "reply" ? intent : { kind: "send", text: intent.text };
    },
    [canMutate, input.isSubagent, iteration, liveGoal, supportsGoals],
  );
  const sendReply = useCallback(
    async (reply: Extract<GoalSendRoute, { kind: "reply" }>) => {
      // A second Enter while the first reply is in flight must not send it twice.
      if (threadId === null || replying.current) return false;
      replying.current = true;
      try {
        const result = await messageGoal({
          environmentId,
          input: {
            type: "thread.goal.message",
            commandId: CommandId.make(randomUUID()),
            threadId,
            goalId: reply.goalId,
            text: reply.text,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return true;
      } catch (cause) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not message the goal",
            description: cause instanceof Error ? cause.message : String(cause),
          }),
        );
        return false;
      } finally {
        replying.current = false;
      }
    },
    [environmentId, messageGoal, threadId],
  );

  const saveBrief = async (brief: GoalBrief) => {
    if (threadId === null || goal === null) throw new Error("This thread has no goal to edit.");
    const result = await updateGoal({
      environmentId,
      input: {
        type: "thread.goal.update",
        commandId: CommandId.make(randomUUID()),
        threadId,
        goalId: goal.id,
        objective: brief.objective,
        doneWhen: brief.doneWhen,
        background: brief.background,
        permissions: brief.permissions,
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  };

  let dialog: ReactNode = null;
  if (editing !== null && thread !== null && editing.threadId === thread.id) {
    const close = () => setEditing(null);
    if (editing.proposal !== null) {
      dialog = (
        <GoalDialog
          key={editing.proposal.id}
          mode="start"
          initial={editing.proposal}
          runtimeMode={thread.runtimeMode}
          canSubmit={commandAvailable}
          onSubmit={async (brief) => {
            await startGoal(brief);
            close();
          }}
          onClose={close}
        />
      );
    } else if (fullGoal !== null && fullGoal.id === goal?.id) {
      dialog = (
        <GoalDialog
          key={fullGoal.id}
          mode="edit"
          initial={fullGoal}
          runtimeMode={thread.runtimeMode}
          canSubmit={canEditGoal}
          onSubmit={async (brief) => {
            await saveBrief(brief);
            close();
          }}
          onClose={close}
        />
      );
    }
  }

  return {
    commandAvailable,
    placeholder: liveGoal === null ? undefined : goalComposerPlaceholder(liveGoal),
    bannerItems,
    dialog,
    routeSend,
    sendReply,
  };
}
