import { useSyncExternalStore } from "react";

const MOBILE_FULLSCREEN_QUERY = "(max-width: 480px)";

function getDisabledSnapshot() {
  return false;
}

function subscribeDisabled() {
  return () => {};
}

function getSnapshot() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_FULLSCREEN_QUERY).matches
  );
}

function subscribe(callback: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mediaQuery = window.matchMedia(MOBILE_FULLSCREEN_QUERY);
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

export function useMobileFullscreen(enabled: boolean): boolean {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeDisabled,
    enabled ? getSnapshot : getDisabledSnapshot,
    getDisabledSnapshot,
  );
}
