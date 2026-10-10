import { useNavigation } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  formatGoalBurnGuard,
  formatGoalUsage,
  GOAL_ITERATION_OUTCOME_LABELS,
  goalControlActions,
  goalIsEditable,
  goalIsLive,
  goalStatusLabel,
} from "@t3tools/client-runtime/state/thread-goals";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  goalIterationTimeoutMins,
  MIN_GOAL_ITERATION_TIMEOUT_MINS,
  type OrchestrationV2GoalProposal,
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
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadProjection } from "../../state/use-thread-detail";
import { RequestActionButton } from "./RequestActionButton";

type GoalFields = Pick<
  Extract<OrchestrationV2Command, { type: "thread.goal.set" }>,
  "objective" | "doneWhen" | "background" | "permissions" | "checkCommand" | "iterationTimeoutMins"
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
  const canMutate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const setGoal = useAtomCommand(threadEnvironment.setGoal, { reportFailure: false });
  const controlGoal = useAtomCommand(threadEnvironment.controlGoal, { reportFailure: false });
  const updateGoal = useAtomCommand(threadEnvironment.updateGoal, { reportFailure: false });
  const dismissProposal = useAtomCommand(threadEnvironment.dismissGoalProposal, {
    reportFailure: false,
  });
  const navigation = useNavigation();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingGoal, setEditingGoal] = useState(false);
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
            {fullGoal !== null && goalIsEditable(goal) ? (
              <RequestActionButton
                tone="secondary"
                label="Edit"
                disabled={!canMutate || pending !== null}
                onPress={() => setEditingGoal(true)}
              />
            ) : null}
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
        <GoalBriefEditor
          key={proposal.id}
          mode="start"
          initial={proposal}
          pending={pending !== null}
          canSubmit={canStart}
          error={error}
          onClose={() => {
            if (pending === null) setEditing(false);
          }}
          onSubmit={(fields) => void run("start", () => start(fields))}
        />
      ) : null}
      {editingGoal && goal !== null && fullGoal !== null && fullGoal.id === goal.id ? (
        <GoalBriefEditor
          key={fullGoal.id}
          mode="edit"
          initial={fullGoal}
          pending={pending !== null}
          canSubmit={canMutate && goalIsEditable(goal)}
          error={error}
          onClose={() => {
            if (pending === null) setEditingGoal(false);
          }}
          onSubmit={(fields) =>
            void run("edit", async () => {
              const result = await updateGoal({
                environmentId: thread.environmentId,
                input: {
                  type: "thread.goal.update",
                  commandId: CommandId.make(uuidv4()),
                  threadId: thread.id,
                  goalId: goal.id,
                  objective: fields.objective,
                  doneWhen: fields.doneWhen,
                  background: fields.background,
                  permissions: fields.permissions,
                },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              setEditingGoal(false);
            })
          }
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

const BRIEF_LABELS = {
  objective: "Objective",
  doneWhen: "Done when",
  permissions: "Pre-approved actions",
  background: "Background",
  iterationTimeoutMins: `Minutes per iteration (${MIN_GOAL_ITERATION_TIMEOUT_MINS}–480)`,
  checkCommand: "Completion check",
};
const ADVANCED_FIELDS = [
  "permissions",
  "background",
  "iterationTimeoutMins",
  "checkCommand",
] as const;

/** Edits a goal's brief: objective and done-when, with the rest under Advanced. */
function GoalBriefEditor(props: {
  /** "start" edits a proposal before it runs; "edit" changes a paused or blocked goal. */
  readonly mode: "start" | "edit";
  readonly initial: {
    readonly objective: string;
    readonly doneWhen?: string | null | undefined;
    readonly background?: string | null | undefined;
    readonly permissions?: string | null | undefined;
    readonly checkCommand?: string | null | undefined;
    readonly iterationTimeoutMins?: number | null | undefined;
  };
  readonly pending: boolean;
  readonly canSubmit: boolean;
  readonly error: string | null;
  readonly onSubmit: (fields: Required<GoalFields>) => void;
  readonly onClose: () => void;
}) {
  // Editing a goal is mostly about widening what it may do, so open the rest.
  const [advanced, setAdvanced] = useState(props.mode === "edit");
  const [fields, setFields] = useState(() => ({
    objective: props.initial.objective,
    doneWhen: props.initial.doneWhen ?? "",
    permissions: props.initial.permissions ?? "",
    background: props.initial.background ?? "",
    iterationTimeoutMins: String(goalIterationTimeoutMins(props.initial)),
    checkCommand: props.initial.checkCommand ?? "",
  }));
  const timeout = Number(fields.iterationTimeoutMins);
  const valid =
    fields.objective.trim().length > 0 &&
    fields.doneWhen.trim().length > 0 &&
    Number.isInteger(timeout) &&
    timeout >= MIN_GOAL_ITERATION_TIMEOUT_MINS &&
    timeout <= 480;
  const field = (key: keyof typeof fields) => (
    <View key={key} className="gap-2">
      <Text className="text-sm">{BRIEF_LABELS[key]}</Text>
      <TextInput
        accessibilityLabel={BRIEF_LABELS[key]}
        value={fields[key]}
        editable={!props.pending}
        multiline={key !== "iterationTimeoutMins" && key !== "checkCommand"}
        keyboardType={key === "iterationTimeoutMins" ? "number-pad" : "default"}
        className="rounded-xl bg-subtle p-3 text-foreground"
        onChangeText={(value) => setFields((current) => ({ ...current, [key]: value }))}
      />
    </View>
  );
  return (
    <GoalModal onClose={props.onClose}>
      <Text accessibilityRole="header" className="text-xl font-t3-bold">
        {props.mode === "start" ? "Edit proposed goal" : "Edit goal"}
      </Text>
      <Text className="text-sm text-foreground-secondary">
        {props.mode === "start"
          ? "Each iteration receives this brief. Start begins the loop."
          : "The next iteration gets the new brief. Resume the goal when you are done."}
      </Text>
      {field("objective")}
      {field("doneWhen")}
      <RequestActionButton
        tone="secondary"
        label={advanced ? "Hide advanced" : "Advanced"}
        disabled={props.pending}
        onPress={() => setAdvanced((value) => !value)}
      />
      {/* thread.goal.update edits the brief only; the time limit and check stay as started. */}
      {advanced
        ? ADVANCED_FIELDS.filter(
            (key) =>
              props.mode === "start" || (key !== "iterationTimeoutMins" && key !== "checkCommand"),
          ).map(field)
        : null}
      {props.error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {props.error}
        </Text>
      ) : null}
      <RequestActionButton
        label={props.pending ? "Saving…" : props.mode === "start" ? "Start goal" : "Save changes"}
        disabled={!props.canSubmit || props.pending || !valid}
        onPress={() =>
          props.onSubmit({
            objective: fields.objective.trim(),
            doneWhen: fields.doneWhen.trim(),
            background: fields.background.trim() || null,
            permissions: fields.permissions.trim() || null,
            checkCommand: fields.checkCommand.trim() || null,
            iterationTimeoutMins: timeout,
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
        {goal.iteration} iterations · {formatGoalUsage(goal)}
      </Text>
      <Text>
        {goalIterationTimeoutMins(goal)} min per iteration · {formatGoalBurnGuard(goal)}
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
          label={`Iteration ${record.iteration}: ${GOAL_ITERATION_OUTCOME_LABELS[record.outcome]}`}
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
