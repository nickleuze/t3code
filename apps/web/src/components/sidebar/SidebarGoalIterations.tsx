import { useState } from "react";
import type { SidebarThreadSummary } from "../../types";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  goalIterationLabel,
  shownGoalIterations,
} from "@t3tools/client-runtime/state/thread-goals";
import { cn } from "../../lib/utils";

export function SidebarGoalIterations(props: {
  goal: SidebarThreadSummary["t3Goal"];
  iterations: readonly SidebarThreadSummary[];
  parked: boolean;
  activeRouteThreadKey: string | null;
  onOpen: (ref: ScopedThreadRef) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (props.iterations.length === 0) return null;
  const shown = shownGoalIterations({
    iterations: props.iterations,
    currentThreadId: props.goal?.currentChildThreadId,
    selectedKey: props.activeRouteThreadKey,
    expanded,
    parked: props.parked,
  });
  return (
    <div
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-6 w-full items-center pl-6 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? "Hide" : "Show"} {props.iterations.length} goal iterations
      </button>
      <ul role="presentation" className="m-0 flex list-none flex-col p-0 pl-6">
        {shown.map((thread) => {
          const ref = scopeThreadRef(thread.environmentId, thread.id);
          const active = scopedThreadKey(ref) === props.activeRouteThreadKey;
          const running = thread.id === props.goal?.currentChildThreadId;
          return (
            <li key={thread.id} role="presentation">
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => props.onOpen(ref)}
                className={cn(
                  "flex h-7 w-full min-w-0 items-center gap-2 rounded-md border-l border-sidebar-border px-2.5 text-left text-xs",
                  active
                    ? "bg-sidebar-row-active text-sidebar-foreground"
                    : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{goalIterationLabel(thread)}</span>
                {running ? (
                  <span className="shrink-0 text-muted-foreground">
                    {props.goal?.needsInput ? "Input" : "Running"}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
