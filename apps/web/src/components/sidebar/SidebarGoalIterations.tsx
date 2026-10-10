import { useState } from "react";
import type { SidebarThreadSummary } from "../../types";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { nestedIterationLabel, selectNestedGoalIterations } from "../Sidebar.logic";
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
  const selected = props.iterations.find(
    (thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
      props.activeRouteThreadKey,
  );
  const limit = expanded
    ? props.iterations.length
    : props.parked
      ? props.goal?.currentChildThreadId
        ? 1
        : 0
      : 3;
  const shown = selectNestedGoalIterations(
    props.iterations,
    props.goal?.currentChildThreadId ?? null,
    limit,
  );
  if (selected && !shown.includes(selected)) shown.push(selected);
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
                <span className="min-w-0 flex-1 truncate">{nestedIterationLabel(thread)}</span>
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
