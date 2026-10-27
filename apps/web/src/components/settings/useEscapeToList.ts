import { useEffect, useEffectEvent } from "react";

/**
 * Escape goes from a page on the Tools tab (a skill, an MCP server) back to
 * its list. Settings leaves the page on Escape from its own window listener,
 * so this one runs first, in the capture phase. Escape inside a field, dialog
 * or menu belongs to that control.
 */
export function useEscapeToList(onBack: () => void) {
  const goBack = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing)
      return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        'input,textarea,select,[contenteditable],[role="dialog"],[role="alertdialog"],[role="menu"]',
      )
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onBack();
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to window keydown for the life of the detail view
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => goBack(event);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}
