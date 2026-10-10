import type { EnvironmentId, ForkUpdateStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ForkUpdateMachine,
  forkUpdateConfirmationMessage,
  resolveForkUpdatePillView,
  shortForkVersion,
} from "./SidebarForkUpdatePill.logic";

const status = (overrides: Partial<ForkUpdateStatus> = {}): ForkUpdateStatus => ({
  supported: true,
  installedVersion: "0.0.44-nick.5",
  latest: { version: "0.0.44-nick.6", commit: "abc", builtAt: "2026-10-10T00:00:00Z" },
  updateAvailable: true,
  checkedAt: "2026-10-10T00:00:00Z",
  installingVersion: null,
  error: null,
  ...overrides,
});

const machine = (
  label: string,
  isPrimary: boolean,
  overrides: Partial<ForkUpdateStatus> = {},
): ForkUpdateMachine => ({
  environmentId: label as EnvironmentId,
  label,
  isPrimary,
  status: status(overrides),
});

describe("resolveForkUpdatePillView", () => {
  it("hides when every machine is current or unsupported", () => {
    expect(
      resolveForkUpdatePillView([
        machine("MacBook", true, { updateAvailable: false }),
        machine("Dev", false, { supported: false }),
      ]),
    ).toBeNull();
  });

  it("orders this machine after remote machines", () => {
    const view = resolveForkUpdatePillView([machine("MacBook", true), machine("Mac mini", false)]);
    expect(view?.pending.map((entry) => entry.label)).toEqual(["Mac mini", "MacBook"]);
    expect(view?.targetVersion).toBe("0.0.44-nick.6");
    expect(view?.tooltip).toBe("Fork nick.6 is available for Mac mini, MacBook. Update all");
  });

  it("reports machines that are installing", () => {
    const view = resolveForkUpdatePillView([
      machine("Mac mini", false, { installingVersion: "0.0.44-nick.6" }),
    ]);
    expect(view?.pending).toEqual([]);
    expect(view?.tooltip).toBe("Installing fork nick.6 on Mac mini once running turns finish");
  });
});

describe("forkUpdateConfirmationMessage", () => {
  it("lists each machine's version change", () => {
    const view = resolveForkUpdatePillView([machine("Mac mini", false)]);
    expect(view && forkUpdateConfirmationMessage(view)).toContain("Mac mini: nick.5 -> nick.6");
  });
});

describe("shortForkVersion", () => {
  it("drops the upstream base version", () => {
    expect(shortForkVersion("0.0.44-nick.12")).toBe("nick.12");
    expect(shortForkVersion("0.0.44")).toBe("0.0.44");
  });
});
