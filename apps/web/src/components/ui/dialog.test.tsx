// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "./dialog";
import { Sheet, SheetPopup, SheetTitle, SheetDescription } from "./sheet";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
  async function render(variant?: "default" | "mobile-fullscreen") {
    await act(async () =>
      root.render(
        <Overlay open>
          <Popup {...(variant === undefined ? {} : { variant })}>
            <Title>Test overlay</Title>
            <Description>Test content</Description>
          </Popup>
        </Overlay>,
      ),
    );
  }

  it("renders the default variant without matchMedia", async () => {
    expect(window.matchMedia).toBeUndefined();
    await expect(render()).resolves.toBeUndefined();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Test content");
  });

  it("does not evaluate a media query for the default variant", async () => {
    const matchMedia = vi.fn();
    vi.stubGlobal("matchMedia", matchMedia);
    await render();
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("renders mobile-fullscreen without matchMedia", async () => {
    await expect(render("mobile-fullscreen")).resolves.toBeUndefined();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Test content");
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
    vi.stubGlobal("matchMedia", matchMedia);

    await render();
    expect(matchMedia).not.toHaveBeenCalled();
    await render("mobile-fullscreen");
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 480px)");
    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(document.querySelector('[role="dialog"]')?.classList.contains("max-w-none")).toBe(true);

    await act(async () => {
      matches = false;
      onChange();
    });
    expect(document.querySelector('[role="dialog"]')?.classList.contains("max-w-none")).toBe(false);
    await render();
    expect(removeEventListener).toHaveBeenCalledWith("change", onChange);
    matchMedia.mockClear();
    await render();
    expect(matchMedia).not.toHaveBeenCalled();
  });
});
