import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  formatGoalTokens,
  goalControlActions,
  goalIsLive,
  goalStatusLabel,
} from "@t3tools/client-runtime/state/thread-goals";
import {
  CommandId,
  type OrchestrationV2GoalProposal,
  type OrchestrationV2GoalIterationOutcome,
  type OrchestrationV2ThreadGoal,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { AppText as Text } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadProjection } from "../../state/use-thread-detail";
import { RequestActionButton } from "./RequestActionButton";

type GoalFields = Omit<
  Extract<OrchestrationV2Command, { type: "thread.goal.set" }>,
  "type" | "commandId" | "threadId"
>;

/** T3-owned goals stay independent from the provider-native goal banner. */
export function T3GoalCard(props: {
  readonly thread: EnvironmentThreadShell;
  readonly supportsGoals: boolean;
}) {
  const { thread } = props;
  const projection = useThreadProjection({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const canMutate = useAtomValue(threadEnvironment.setGoal.permissionAtom(thread.environmentId));
  const setGoal = useAtomCommand(threadEnvironment.setGoal, { reportFailure: false });
  const controlGoal = useAtomCommand(threadEnvironment.controlGoal, { reportFailure: false });
  const dismissProposal = useAtomCommand(threadEnvironment.dismissGoalProposal, {
    reportFailure: false,
  });
  const navigation = useNavigation();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [editing, setEditing] = useState(false);
  const inFlight = useRef(false);
  const startedProposal = useRef<CommandId | null>(null);
  const [startedProposalId, setStartedProposalId] = useState<CommandId | null>(null);
  const goal = thread.t3Goal ?? null;
  const proposal = thread.goalProposal ?? null;
  const iteration = thread.goalIteration ?? null;
  if (!props.supportsGoals || (goal === null && proposal === null && iteration === null))
    return null;
  const canStart =
    canMutate &&
    iteration === null &&
    thread.lineage.relationshipToParent !== "subagent" &&
    !(goal !== null && goalIsLive(goal));
  const openThread = (threadId: string) => {
    Keyboard.dismiss();
    navigation.navigate("Thread", { environmentId: String(thread.environmentId), threadId });
  };
  const run = async (label: string, action: () => Promise<void>) => {
    if (!canMutate || inFlight.current) return;
    inFlight.current = true;
    setPending(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the T3 goal.");
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };
  const start = async (fields: GoalFields) => {
    if (!canStart || proposal === null || startedProposal.current === proposal.id) return;
    startedProposal.current = proposal.id;
    setStartedProposalId(proposal.id);
    try {
      const result = await setGoal({
        environmentId: thread.environmentId,
        input: {
          type: "thread.goal.set",
          commandId: CommandId.make(uuidv4()),
          threadId: thread.id,
          ...fields,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setEditing(false);
    } catch (cause) {
      startedProposal.current = null;
      setStartedProposalId(null);
      throw cause;
    }
  };
  const fullGoal = projection?.projection.thread.goal ?? null;
  const showProposal = proposal !== null && !(goal !== null && goalIsLive(goal));
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-screen p-3">
      {goal !== null ? (
        <>
          <Text accessibilityRole="header" className="text-sm font-t3-bold">
            T3 goal · {goalStatusLabel(goal)}
          </Text>
          <Text numberOfLines={2} className="text-sm text-foreground-secondary">
            {goal.summaryNote ?? goal.objective}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {goal.currentChildThreadId !== null ? (
              <RequestActionButton
                tone="secondary"
                label={goal.needsInput ? "Answer iteration" : "Open iteration"}
                onPress={() => openThread(String(goal.currentChildThreadId))}
              />
            ) : null}
            {goalControlActions(goal).map((action) => (
              <RequestActionButton
                key={action}
                tone={action === "stop" ? "danger" : "secondary"}
                label={
                  action === pending ? "Updating…" : action[0]!.toUpperCase() + action.slice(1)
                }
                disabled={!canMutate || pending !== null}
                onPress={() =>
                  void run(action, async () => {
                    const result = await controlGoal({
                      environmentId: thread.environmentId,
                      input: {
                        type: "thread.goal.control",
                        commandId: CommandId.make(uuidv4()),
                        threadId: thread.id,
                        goalId: goal.id,
                        action,
                      },
                    });
                    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  })
                }
              />
            ))}
            {fullGoal !== null ? (
              <RequestActionButton
                tone="secondary"
                label="Goal details"
                onPress={() => setDetails(true)}
              />
            ) : null}
          </View>
        </>
      ) : null}
      {showProposal ? (
        <>
          <Text accessibilityRole="header" className="text-sm font-t3-bold">
            Proposed T3 goal: {proposal.objective}
          </Text>
          <Text numberOfLines={3} className="text-sm text-foreground-secondary">
            Done when: {proposal.doneWhen}
          </Text>
          {proposal.checkCommand ? (
            <Text className="text-xs text-foreground-secondary">
              Check: {proposal.checkCommand}
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <RequestActionButton
              label={pending === "start" ? "Starting…" : "Start goal"}
              disabled={!canStart || pending !== null || startedProposalId === proposal.id}
              onPress={() => void run("start", () => start(proposalFields(proposal)))}
            />
            <RequestActionButton
              tone="secondary"
              label="Edit"
              disabled={!canStart || pending !== null || startedProposalId === proposal.id}
              onPress={() => setEditing(true)}
            />
            <RequestActionButton
              tone="secondary"
              label="Dismiss"
              disabled={!canMutate || pending !== null}
              onPress={() =>
                void run("dismiss", async () => {
                  const result = await dismissProposal({
                    environmentId: thread.environmentId,
                    input: {
                      type: "thread.goal.proposal.dismiss",
                      commandId: CommandId.make(uuidv4()),
                      threadId: thread.id,
                      proposalId: proposal.id,
                    },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                })
              }
            />
          </View>
        </>
      ) : null}
      {iteration !== null ? (
        <>
          <Text className="text-sm">T3 goal iteration {iteration.iteration}</Text>
          <RequestActionButton
            tone="secondary"
            label="Open goal"
            onPress={() => openThread(String(iteration.parentThreadId))}
          />
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
      {editing && showProposal ? (
        <GoalProposalEditor
          key={proposal.id}
          proposal={proposal}
          pending={pending !== null}
          canStart={canStart}
          error={error}
          onClose={() => {
            if (pending === null) setEditing(false);
          }}
          onStart={(fields) => void run("start", () => start(fields))}
        />
      ) : null}
      {details && fullGoal !== null ? (
        <GoalDetails goal={fullGoal} onClose={() => setDetails(false)} onOpen={openThread} />
      ) : null}
    </View>
  );
}

function proposalFields(proposal: OrchestrationV2GoalProposal): GoalFields {
  return {
    objective: proposal.objective,
    doneWhen: proposal.doneWhen,
    background: proposal.background,
    permissions: proposal.permissions,
    checkCommand: proposal.checkCommand,
    ...(proposal.iterationTimeoutMins === null
      ? {}
      : { iterationTimeoutMins: proposal.iterationTimeoutMins }),
  };
}

function GoalModal(props: { readonly children: React.ReactNode; readonly onClose: () => void }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        className="flex-1 items-center justify-center bg-backdrop px-6"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          className="max-h-[80%] w-full max-w-md grow-0 rounded-3xl bg-screen"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 24, gap: 16 }}
        >
          {props.children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function GoalProposalEditor(props: {
  readonly proposal: OrchestrationV2GoalProposal;
  readonly pending: boolean;
  readonly canStart: boolean;
  readonly error: string | null;
  readonly onStart: (fields: GoalFields) => void;
  readonly onClose: () => void;
}) {
  const [guardEnabled, setGuardEnabled] = useState(true);
  const [fields, setFields] = useState(() => ({
    objective: props.proposal.objective,
    doneWhen: props.proposal.doneWhen,
    background: props.proposal.background ?? "",
    permissions: props.proposal.permissions ?? "",
    checkCommand: props.proposal.checkCommand ?? "",
    iterationTimeoutMins: String(props.proposal.iterationTimeoutMins ?? 120),
    maxPercentPoints: "20",
    windowMins: "60",
    noProgressLimit: "3",
  }));
  const timeout = Number(fields.iterationTimeoutMins);
  const maxPercentPoints = Number(fields.maxPercentPoints);
  const windowMins = Number(fields.windowMins);
  const noProgressLimit = Number(fields.noProgressLimit);
  const valid =
    fields.objective.trim().length > 0 &&
    fields.doneWhen.trim().length > 0 &&
    Number.isInteger(timeout) &&
    timeout >= 15 &&
    timeout <= 480 &&
    Number.isInteger(noProgressLimit) &&
    noProgressLimit >= 1 &&
    noProgressLimit <= 20 &&
    (!guardEnabled ||
      (Number.isInteger(maxPercentPoints) &&
        maxPercentPoints >= 1 &&
        maxPercentPoints <= 100 &&
        Number.isInteger(windowMins) &&
        windowMins >= 5));
  const labels = {
    objective: "Objective",
    doneWhen: "Done when",
    background: "Background",
    permissions: "Pre-approved actions",
    checkCommand: "Completion check",
    iterationTimeoutMins: "Minutes per iteration (15–480)",
    maxPercentPoints: "Max usage rise (%)",
    windowMins: "Burn guard window (minutes)",
    noProgressLimit: "Idle iterations before pausing (1–20)",
  };
  return (
    <GoalModal onClose={props.onClose}>
      <Text accessibilityRole="header" className="text-xl font-t3-bold">
        Edit T3 goal
      </Text>
      <Text className="text-sm text-foreground-secondary">
        Each iteration receives this brief. Start begins the loop.
      </Text>
      {(Object.keys(fields) as Array<keyof typeof fields>)
        .filter((key) => guardEnabled || (key !== "maxPercentPoints" && key !== "windowMins"))
        .map((key) => (
          <View key={key} className="gap-2">
            <Text className="text-sm">{labels[key]}</Text>
            <TextInput
              accessibilityLabel={labels[key]}
              value={fields[key]}
              editable={!props.pending}
              multiline={["objective", "doneWhen", "background", "permissions"].includes(key)}
              keyboardType={
                [
                  "iterationTimeoutMins",
                  "maxPercentPoints",
                  "windowMins",
                  "noProgressLimit",
                ].includes(key)
                  ? "number-pad"
                  : "default"
              }
              className="rounded-xl bg-subtle p-3 text-foreground"
              onChangeText={(value) => setFields((current) => ({ ...current, [key]: value }))}
            />
          </View>
        ))}
      <RequestActionButton
        tone="secondary"
        label={guardEnabled ? "Turn burn guard off" : "Turn burn guard on"}
        disabled={props.pending}
        onPress={() => setGuardEnabled((value) => !value)}
      />
      <Text className="text-xs text-foreground-secondary">
        The burn guard watches account-wide provider usage and pauses a goal if it rises too fast.
      </Text>
      {props.error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {props.error}
        </Text>
      ) : null}
      <RequestActionButton
        label={props.pending ? "Starting…" : "Start goal"}
        disabled={!props.canStart || props.pending || !valid}
        onPress={() =>
          props.onStart({
            objective: fields.objective.trim(),
            doneWhen: fields.doneWhen.trim(),
            background: fields.background.trim() || null,
            permissions: fields.permissions.trim() || null,
            checkCommand: fields.checkCommand.trim() || null,
            iterationTimeoutMins: timeout,
            burnGuard: guardEnabled ? { maxPercentPoints, windowMins } : null,
            noProgressLimit,
          })
        }
      />
      <RequestActionButton
        tone="secondary"
        label="Cancel"
        disabled={props.pending}
        onPress={props.onClose}
      />
    </GoalModal>
  );
}

const OUTCOME_LABELS: Record<OrchestrationV2GoalIterationOutcome, string> = {
  continued: "Continued",
  claimed_complete: "Completed",
  check_failed: "Check failed",
  blocked: "Blocked",
  failed: "Failed",
  interrupted: "Interrupted",
  usage_limited: "Usage limit",
  timed_out: "Out of time",
};

function GoalDetails(props: {
  readonly goal: OrchestrationV2ThreadGoal;
  readonly onClose: () => void;
  readonly onOpen: (threadId: string) => void;
}) {
  const { goal } = props;
  // oxlint-disable-next-line unicorn/no-array-reverse -- Hermes lacks toReversed; reverse only the new copy.
  const history = [...goal.history].reverse();
  return (
    <GoalModal onClose={props.onClose}>
      <Text accessibilityRole="header" className="text-xl font-t3-bold">
        T3 goal
      </Text>
      <Text>{goal.objective}</Text>
      <Text>
        {goal.iteration} iterations ·{" "}
        {goal.usageAccounting === "unavailable"
          ? "Token usage not reported"
          : `${goal.usageAccounting === "estimated" ? "~" : ""}${formatGoalTokens(goal.tokensUsed)}`}
      </Text>
      {goal.doneWhen ? <Text>Done when: {goal.doneWhen}</Text> : null}
      {goal.permissions ? <Text>Pre-approved: {goal.permissions}</Text> : null}
      {goal.handoffPath ? <Text>Handoff: {goal.handoffPath}</Text> : null}
      {goal.completedSummary ? <Text>{goal.completedSummary}</Text> : null}
      {goal.lastCheck ? (
        <Text>
          Check {goal.lastCheck.passed ? "passed" : "failed"}: {goal.lastCheck.command}
          {"\n"}
          {goal.lastCheck.outputTail}
        </Text>
      ) : null}
      {goal.progressNotes.slice(-5).map((note) => (
        <Text key={`${note.iteration}:${note.at}`}>
          #{note.iteration}: {note.text}
        </Text>
      ))}
      {goal.current ? (
        <RequestActionButton
          tone="secondary"
          label={`Open iteration ${goal.current.iteration}`}
          onPress={() => {
            props.onClose();
            props.onOpen(String(goal.current!.childThreadId));
          }}
        />
      ) : null}
      {history.map((record) => (
        <RequestActionButton
          key={record.iteration}
          tone="secondary"
          label={`Iteration ${record.iteration}: ${OUTCOME_LABELS[record.outcome]}`}
          onPress={() => {
            props.onClose();
            props.onOpen(String(record.childThreadId));
          }}
        />
      ))}
      <RequestActionButton tone="secondary" label="Close" onPress={props.onClose} />
    </GoalModal>
  );
}
