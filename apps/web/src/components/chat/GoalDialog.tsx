import {
  DEFAULT_GOAL_ITERATION_TIMEOUT_MINS,
  goalIterationTimeoutMins,
  MIN_GOAL_ITERATION_TIMEOUT_MINS,
  type RuntimeMode,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Textarea } from "../ui/textarea";

/** The brief every iteration receives. Limits the dialog does not show keep their server values. */
export interface GoalBrief {
  readonly objective: string;
  readonly doneWhen: string;
  readonly background: string | null;
  readonly permissions: string | null;
  readonly checkCommand: string | null;
  readonly iterationTimeoutMins: number;
}

interface GoalDialogProps {
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
  readonly runtimeMode: RuntimeMode;
  readonly canSubmit: boolean;
  readonly onSubmit: (brief: GoalBrief) => Promise<void>;
  readonly onClose: () => void;
}

/** Edits a goal's brief: what it achieves and when it is done, with the rest under Advanced. */
export function GoalDialog({
  mode,
  initial,
  runtimeMode,
  canSubmit,
  onSubmit,
  onClose,
}: GoalDialogProps) {
  const id = useId();
  const [objective, setObjective] = useState(initial.objective);
  const [doneWhen, setDoneWhen] = useState(initial.doneWhen ?? "");
  const [background, setBackground] = useState(initial.background ?? "");
  const [permissions, setPermissions] = useState(initial.permissions ?? "");
  const [checkCommand, setCheckCommand] = useState(initial.checkCommand ?? "");
  const [timeoutMins, setTimeoutMins] = useState<number | null>(goalIterationTimeoutMins(initial));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const verb = mode === "start" ? "Start goal" : "Save changes";

  const submit = async () => {
    if (!canSubmit || submitting.current) return;
    const trimmed = objective.trim();
    if (trimmed.length === 0) return setError("Describe what the goal should achieve.");
    if (doneWhen.trim().length === 0) {
      return setError("Say what done looks like, so the goal can finish.");
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await onSubmit({
        objective: trimmed,
        doneWhen: doneWhen.trim(),
        background: background.trim() || null,
        permissions: permissions.trim() || null,
        checkCommand: checkCommand.trim() || null,
        iterationTimeoutMins: Math.max(
          MIN_GOAL_ITERATION_TIMEOUT_MINS,
          Math.round(timeoutMins ?? DEFAULT_GOAL_ITERATION_TIMEOUT_MINS),
        ),
      });
    } catch (cause) {
      submitting.current = false;
      setError(cause instanceof Error ? cause.message : "Could not save the goal.");
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === "start" ? "Edit proposed goal" : "Edit goal"}</DialogTitle>
            <DialogDescription>
              {mode === "start"
                ? "Each iteration starts in a fresh thread and sees only this brief and earlier progress notes."
                : "The next iteration gets the new brief. Resume the goal when you are done."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-objective`}>Goal</Label>
                <Textarea
                  id={`${id}-objective`}
                  rows={3}
                  autoFocus
                  value={objective}
                  onChange={(event) => {
                    setObjective(event.target.value);
                    setError(null);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-done`}>Done when</Label>
                <Textarea
                  id={`${id}-done`}
                  rows={2}
                  value={doneWhen}
                  onChange={(event) => {
                    setDoneWhen(event.target.value);
                    setError(null);
                  }}
                />
              </div>
              {/* Editing a goal is mostly about widening what it may do, so open the rest. */}
              <Collapsible defaultOpen={mode === "edit"}>
                <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                  <ChevronRightIcon className="size-4 transition-transform group-data-panel-open:rotate-90" />
                  Advanced
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="flex flex-col gap-4 pt-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${id}-permissions`}>Pre-approved actions</Label>
                      <Textarea
                        id={`${id}-permissions`}
                        rows={2}
                        value={permissions}
                        placeholder="Commit and push to the goal branch and open PRs. Ask before merging."
                        onChange={(event) => setPermissions(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Anything else that needs your approval, the agent asks for and waits.
                      </p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${id}-background`}>Background</Label>
                      <Textarea
                        id={`${id}-background`}
                        rows={4}
                        value={background}
                        placeholder="Context every iteration should know: the plan, constraints, where things live."
                        onChange={(event) => setBackground(event.target.value)}
                      />
                    </div>
                    {/* thread.goal.update edits the brief only; the time limit and check stay as started. */}
                    {mode === "start" ? (
                      <div className="grid grid-cols-2 gap-3">
                        <NumberField
                          id={`${id}-timeout`}
                          min={MIN_GOAL_ITERATION_TIMEOUT_MINS}
                          max={480}
                          step={15}
                          value={timeoutMins}
                          onValueChange={setTimeoutMins}
                        >
                          <Label htmlFor={`${id}-timeout`}>Minutes per iteration</Label>
                          <NumberFieldGroup>
                            <NumberFieldDecrement aria-label="Decrease iteration time limit" />
                            <NumberFieldInput />
                            <NumberFieldIncrement aria-label="Increase iteration time limit" />
                          </NumberFieldGroup>
                        </NumberField>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`${id}-check`}>Completion check</Label>
                          <Input
                            id={`${id}-check`}
                            value={checkCommand}
                            placeholder="pnpm test"
                            onChange={(event) => setCheckCommand(event.target.value)}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </CollapsiblePanel>
              </Collapsible>
              {runtimeMode === "approval-required" || runtimeMode === "auto-accept-edits" ? (
                <p className="text-xs text-warning">
                  This thread asks before running commands, so each iteration will wait for your
                  approvals. Use auto or full access to let the goal run unattended.
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || pending}>
              {pending ? "Saving..." : verb}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
