import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { FLAT_THREAD_SORT_OPTIONS } from "@t3tools/client-runtime/state/thread-sort";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { ActiveThreadSortOrder } from "./threadListV2";

const INBOX_THREAD_SORT_OPTIONS = [
  {
    value: "returned",
    label: "Last returned",
    description: "Most recently returned threads first.",
  },
  ...FLAT_THREAD_SORT_OPTIONS.filter((option) => option.value !== "manual"),
] as const;

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled !== false;
  const activeThreadSortOrder: ActiveThreadSortOrder = workingShelfEnabled
    ? (preferencesResult.value.inboxThreadSortOrder ?? "returned")
    : loaded
      ? (preferencesResult.value.sidebarFlatThreadSortOrder ?? "manual")
      : "manual";
  const threadSortOptions = workingShelfEnabled
    ? INBOX_THREAD_SORT_OPTIONS
    : FLAT_THREAD_SORT_OPTIONS;
  const setThreadSortOrder = (value: string) => {
    const option = threadSortOptions.find((option) => option.value === value);
    if (!loaded || option === undefined) return;
    if (workingShelfEnabled && option.value !== "manual") {
      savePreferences({ inboxThreadSortOrder: option.value });
    } else if (!workingShelfEnabled && option.value !== "returned") {
      savePreferences({ sidebarFlatThreadSortOrder: option.value });
    }
  };
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  return {
    loaded,
    activeThreadSortOrder,
    threadSortOptions,
    setThreadSortOrder,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
