import type { OrchestrationV2GoalBurnGuard, RuntimeMode } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/button";
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

export interface GoalDialogSubmission {
  readonly objective: string;
  readonly checkCommand: string | null;
  readonly burnGuard: OrchestrationV2GoalBurnGuard | null;
  readonly noProgressLimit: number;
}

interface GoalDialogProps {
  readonly initialObjective: string;
  readonly runtimeMode: RuntimeMode;
  readonly onSubmit: (submission: GoalDialogSubmission) => Promise<void>;
  readonly onClose: () => void;
}

/** Collects a `/goal` objective and its limits before the loop starts. */
export function GoalDialog({ initialObjective, runtimeMode, onSubmit, onClose }: GoalDialogProps) {
  const id = useId();
  const [objective, setObjective] = useState(initialObjective);
  const [checkCommand, setCheckCommand] = useState("");
  const [guardEnabled, setGuardEnabled] = useState(true);
  const [maxPercentPoints, setMaxPercentPoints] = useState<number | null>(20);
  const [windowMins, setWindowMins] = useState<number | null>(60);
  const [noProgressLimit, setNoProgressLimit] = useState<number | null>(3);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = objective.trim();
    if (trimmed.length === 0) return setError("Describe what the goal should achieve.");
    if (guardEnabled && (!maxPercentPoints || !windowMins)) {
      return setError("Set both burn guard values, or turn the guard off.");
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit({
        objective: trimmed,
        checkCommand: checkCommand.trim() || null,
        burnGuard:
          guardEnabled && maxPercentPoints && windowMins
            ? { maxPercentPoints, windowMins: Math.round(windowMins) }
            : null,
        noProgressLimit: Math.max(1, Math.round(noProgressLimit ?? 3)),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the goal.");
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
            <DialogTitle>Start a goal</DialogTitle>
            <DialogDescription>
              The agent works in repeated iterations until the goal is done. Each iteration starts
              fresh in this workspace and sees only the goal and earlier progress notes.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-objective`}>Goal</Label>
                <Textarea
                  id={`${id}-objective`}
                  rows={4}
                  autoFocus
                  value={objective}
                  placeholder="Migrate every API route to the new auth middleware, with tests."
                  onChange={(event) => {
                    setObjective(event.target.value);
                    setError(null);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-check`}>Completion check (optional)</Label>
                <Input
                  id={`${id}-check`}
                  value={checkCommand}
                  placeholder="pnpm test"
                  onChange={(event) => setCheckCommand(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Runs in the workspace when the agent says it is done. The goal only completes if
                  it exits successfully; otherwise the output goes to the next iteration.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor={`${id}-guard`}>Burn guard</Label>
                  <Switch
                    id={`${id}-guard`}
                    checked={guardEnabled}
                    onCheckedChange={setGuardEnabled}
                  />
                </div>
                {guardEnabled ? (
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField
                      id={`${id}-points`}
                      min={1}
                      max={100}
                      value={maxPercentPoints}
                      onValueChange={setMaxPercentPoints}
                    >
                      <Label htmlFor={`${id}-points`}>Max usage rise (%)</Label>
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label="Decrease usage rise" />
                        <NumberFieldInput />
                        <NumberFieldIncrement aria-label="Increase usage rise" />
                      </NumberFieldGroup>
                    </NumberField>
                    <NumberField
                      id={`${id}-window`}
                      min={5}
                      step={5}
                      value={windowMins}
                      onValueChange={setWindowMins}
                    >
                      <Label htmlFor={`${id}-window`}>Within (minutes)</Label>
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label="Decrease window" />
                        <NumberFieldInput />
                        <NumberFieldIncrement aria-label="Increase window" />
                      </NumberFieldGroup>
                    </NumberField>
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Pauses the goal if any of the provider's usage limits climbs faster than this. It
                  watches account-wide usage, so other threads count too.
                </p>
              </div>
              <NumberField
                id={`${id}-no-progress`}
                min={1}
                max={20}
                value={noProgressLimit}
                onValueChange={setNoProgressLimit}
              >
                <Label htmlFor={`${id}-no-progress`}>Pause after iterations without progress</Label>
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="Decrease no-progress limit" />
                  <NumberFieldInput />
                  <NumberFieldIncrement aria-label="Increase no-progress limit" />
                </NumberFieldGroup>
              </NumberField>
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
            <Button type="submit" disabled={pending}>
              {pending ? "Starting..." : "Start goal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
