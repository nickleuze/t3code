import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "./dialog";
import { Sheet, SheetPopup, SheetTitle, SheetDescription } from "./sheet";

const popup = () => document.querySelector('[role="dialog"]');

describe.each([
  {
    name: "Dialog",
    Overlay: Dialog,
    Popup: DialogPopup,
    Title: DialogTitle,
    Description: DialogDescription,
  },
  {
    name: "Sheet",
    Overlay: Sheet,
    Popup: SheetPopup,
    Title: SheetTitle,
    Description: SheetDescription,
  },
])("$name media query isolation", ({ Overlay, Popup, Title, Description }) => {
  const overlay = (variant?: "default" | "mobile-fullscreen") => (
    <Overlay open>
      <Popup {...(variant === undefined ? {} : { variant })}>
        <Title>Test overlay</Title>
        <Description>Test content</Description>
      </Popup>
    </Overlay>
  );

  it("renders the default variant without matchMedia", async () => {
    using _matchMedia = stubGlobal("matchMedia", undefined);
    await using _screen = await render(overlay(), { router: false });
    expect(popup()?.textContent).toContain("Test content");
  });

  it("does not evaluate a media query for the default variant", async () => {
    const matchMedia = vi.fn();
    using _matchMedia = stubGlobal("matchMedia", matchMedia);
    await using _screen = await render(overlay(), { router: false });
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("renders mobile-fullscreen without matchMedia", async () => {
    using _matchMedia = stubGlobal("matchMedia", undefined);
    await using _screen = await render(overlay("mobile-fullscreen"), { router: false });
    expect(popup()?.textContent).toContain("Test content");
  });

  it("subscribes only while mobile-fullscreen is enabled and reacts to width changes", async () => {
    let matches = true;
    let onChange = () => {};
    const addEventListener = vi.fn((_event: string, callback: () => void) => {
      onChange = callback;
    });
    const removeEventListener = vi.fn();
    const matchMedia = vi.fn(() => ({
      get matches() {
        return matches;
      },
      addEventListener,
      removeEventListener,
    }));
    using _matchMedia = stubGlobal("matchMedia", matchMedia);

    await using screen = await render(overlay(), { router: false });
    expect(matchMedia).not.toHaveBeenCalled();
    await screen.rerender(overlay("mobile-fullscreen"));
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 480px)");
    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(popup()?.classList.contains("max-w-none")).toBe(true);

    await act(() => {
      matches = false;
      onChange();
    });
    expect(popup()?.classList.contains("max-w-none")).toBe(false);
    await screen.rerender(overlay());
    expect(removeEventListener).toHaveBeenCalledWith("change", onChange);
    matchMedia.mockClear();
    await screen.rerender(overlay());
    expect(matchMedia).not.toHaveBeenCalled();
  });
});
