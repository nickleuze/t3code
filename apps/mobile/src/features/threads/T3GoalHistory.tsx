import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

/** Read-only navigation stays outside the owner's swipe/mutation surface. */
export function T3GoalHistory(props: {
  readonly owner: EnvironmentThreadShell;
  readonly iterations: readonly EnvironmentThreadShell[];
  readonly selectedThreadKey?: string | null;
  readonly parked?: boolean;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(13);
  const currentId = props.owner.t3Goal?.currentChildThreadId;
  const current = props.iterations.find((thread) => thread.id === currentId);
  const ordered = [
    ...(current ? [current] : []),
    ...props.iterations.filter((thread) => thread !== current),
  ];
  const selected = ordered.find(
    (thread) => `${thread.environmentId}:${thread.id}` === props.selectedThreadKey,
  );
  const visible = expanded
    ? ordered.slice(0, limit)
    : props.parked
      ? current
        ? [current]
        : []
      : ordered.slice(0, 3);
  if (selected && !visible.includes(selected)) visible.push(selected);
  return (
    <View className="gap-1 pb-2 pl-8 pr-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? "Hide" : "Show"} goal iterations for ${props.owner.title}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-11 justify-center"
      >
        <Text className="text-sm text-foreground-muted">
          {expanded ? "Hide" : "Show"} iterations ({ordered.length})
        </Text>
      </Pressable>
      {visible.map((thread) => (
        <Pressable
          key={`${thread.environmentId}:${thread.id}`}
          accessibilityRole="button"
          accessibilityState={{ selected: thread === selected }}
          accessibilityLabel={`Open goal iteration ${thread.goalIteration?.iteration}: ${thread.title}`}
          onPress={() => props.onSelectThread(thread)}
          className="min-h-11 justify-center rounded-lg px-2 active:bg-subtle"
        >
          <Text
            className={
              thread === selected ? "text-sm text-accent" : "text-sm text-foreground-muted"
            }
            numberOfLines={2}
          >
            #{thread.goalIteration?.iteration}{" "}
            {thread.title.replace(/^Goal (?:#|iteration )\d+:\s*/, "")}
            {thread.id === currentId ? " · Current" : ""}
          </Text>
        </Pressable>
      ))}
      {expanded && visible.length < ordered.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show more goal iterations"
          onPress={() => setLimit((value) => value + 10)}
          className="min-h-11 justify-center"
        >
          <Text className="text-sm text-foreground-muted">
            Show more ({ordered.length - visible.length})
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
