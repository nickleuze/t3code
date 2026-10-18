import { EnvironmentId, type HostDeployment, type HostDeploymentRequest } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  hostDeploymentMilestones,
  hostDeploymentReached,
  hostDeploymentStatusLabel,
  latestHostDeployment,
  releaseDeploymentDone,
  runReleaseDeployment,
  type HostDeploymentWait,
} from "./hostDeployments.ts";
import type { UpdateAllState } from "./updateAllMachines.ts";

const MINI = EnvironmentId.make("env-mini");
const MACBOOK = EnvironmentId.make("env-macbook");
const request: HostDeploymentRequest = {
  releaseId: "0.0.46-nick.22",
  version: "0.0.46-nick.22",
  commit: "abcdef1234567890abcdef1234567890abcdef12",
  artifactSha256: "sha256",
  artifactSha512: "sha512",
  feed: { owner: "nickleuze", repo: "t3code" },
  acceptanceScope: "Project creation works",
  targets: [
    { environmentId: MINI, label: "Mini", role: "remote" },
    { environmentId: MACBOOK, label: "MacBook", role: "local" },
  ],
  approvedAt: "2026-10-17T12:00:00.000Z",
};

function record(overrides: Partial<HostDeployment>): HostDeployment {
  return {
    request,
    environmentId: MINI,
    role: "remote",
    status: "preparing",
    step: "preflight",
    reason: null,
    from: null,
    runtime: null,
    milestones: {
      approvedAt: request.approvedAt,
      publishedAt: null,
      installedAt: null,
      verifiedAt: null,
      acceptedAt: null,
    },
    admission: null,
    backup: null,
    acceptance: null,
    updatedAt: request.approvedAt,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Hosts whose records resolve when the test says so. */
function makeHosts() {
  const waits = new Map<string, ReturnType<typeof deferred<HostDeployment>>>();
  const wait = (environmentId: string, until: HostDeploymentWait) => {
    const key = `${environmentId}:${until}`;
    if (!waits.has(key)) waits.set(key, deferred<HostDeployment>());
    return waits.get(key)!;
  };
  const states: UpdateAllState[] = [];
  const submit = vi.fn(async (environmentId: EnvironmentId) =>
    record({ environmentId, role: environmentId === MACBOOK ? "local" : "remote" }),
  );
  const admit = vi.fn(async (environmentId: EnvironmentId) =>
    record({ environmentId, role: "local" }),
  );
  const run = () =>
    runReleaseDeployment({
      request,
      submit,
      awaitDeployment: (environmentId, until) => wait(environmentId, until).promise,
      admit,
      onState: (state) => states.push(state),
    });
  return { wait, states, submit, admit, run };
}

/** Lets the sequencer's pending promise callbacks run. */
const flush = async () => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

describe("runReleaseDeployment", () => {
  it("admits the local host only after every remote verified", async () => {
    const hosts = makeHosts();
    const running = hosts.run();
    await flush();
    expect(hosts.submit).toHaveBeenCalledWith(MINI, request);
    expect(hosts.submit).toHaveBeenCalledWith(MACBOOK, request);

    hosts
      .wait(MACBOOK, "admission")
      .resolve(
        record({ environmentId: MACBOOK, role: "local", status: "waiting", step: "admission" }),
      );
    await flush();
    expect(hosts.admit).not.toHaveBeenCalled();

    hosts.wait(MINI, "settled").resolve(record({ status: "verified", step: "verify" }));
    await running;
    expect(hosts.admit).toHaveBeenCalledWith(MACBOOK, "remotes-verified", "Verified on Mini.");
    expect(hosts.states.at(-1)?.remotes[MINI]).toEqual({
      status: "succeeded",
      targetVersion: request.version,
    });
  });

  it("blocks the local install when a remote restarts on the wrong version", async () => {
    const hosts = makeHosts();
    const running = hosts.run();
    hosts
      .wait(MACBOOK, "admission")
      .resolve(
        record({ environmentId: MACBOOK, role: "local", status: "waiting", step: "admission" }),
      );
    const reason =
      "Restarted on 0.0.46-nick.21 (0123456789ab); expected 0.0.46-nick.22 (abcdef123456).";
    hosts.wait(MINI, "settled").resolve(record({ status: "failed", step: "verify", reason }));
    await running;
    expect(hosts.admit).not.toHaveBeenCalled();
    expect(hosts.states.at(-1)?.remotes[MINI]).toEqual({ status: "failed", message: reason });
  });

  it("keeps the local host waiting while a required remote is offline", async () => {
    const hosts = makeHosts();
    void hosts.run();
    hosts
      .wait(MACBOOK, "admission")
      .resolve(
        record({ environmentId: MACBOOK, role: "local", status: "waiting", step: "admission" }),
      );
    await flush();
    // The Mini's record never arrives while it is offline.
    expect(hosts.states.at(-1)).toMatchObject({
      local: "ready",
      remotes: { [MINI]: { status: "updating" } },
    });
    expect(hosts.admit).not.toHaveBeenCalled();
  });

  it("stops before admission when the local host is blocked", async () => {
    const hosts = makeHosts();
    const running = hosts.run();
    hosts.wait(MACBOOK, "admission").resolve(
      record({
        environmentId: MACBOOK,
        role: "local",
        status: "blocked",
        step: "preflight",
        reason: "Free space is too low.",
      }),
    );
    hosts.wait(MINI, "settled").resolve(record({ status: "verified" }));
    await running;
    expect(hosts.admit).not.toHaveBeenCalled();
    expect(hosts.states.at(-1)).toMatchObject({
      local: "failed",
      localError: "Free space is too low.",
    });
  });
});

describe("host deployment progress", () => {
  it("treats an admitted or stopped local record as past admission, so a resume does not hang", () => {
    expect(hostDeploymentReached(record({ status: "waiting", step: "idle" }), "admission")).toBe(
      false,
    );
    expect(
      hostDeploymentReached(
        record({
          status: "installing",
          step: "backup",
          admission: { mode: "local-only", evidence: "Mini offline", at: request.approvedAt },
        }),
        "admission",
      ),
    ).toBe(true);
    expect(hostDeploymentReached(record({ status: "verified" }), "settled")).toBe(true);
    expect(hostDeploymentReached(record({ status: "installing", step: "commit" }), "settled")).toBe(
      false,
    );
  });

  it("is done only when every target recorded acceptance", () => {
    const verified = new Map([
      [MINI as string, record({ status: "accepted" })],
      [MACBOOK as string, record({ environmentId: MACBOOK, status: "verified" })],
    ]);
    expect(releaseDeploymentDone(request, verified)).toBe(false);
    verified.set(MACBOOK, record({ environmentId: MACBOOK, status: "accepted" }));
    expect(releaseDeploymentDone(request, verified)).toBe(true);
  });
});

function presentationRecord(overrides: {
  readonly version?: string;
  readonly approvedAt?: string;
  readonly updatedAt?: string;
  readonly status?: HostDeployment["status"];
  readonly step?: HostDeployment["step"];
  readonly milestones?: Partial<HostDeployment["milestones"]>;
}): HostDeployment {
  const environmentId = EnvironmentId.make("env-1");
  const version = overrides.version ?? "1.2.0";
  const approvedAt = overrides.approvedAt ?? "2026-10-01T10:00:00.000Z";
  return {
    request: {
      releaseId: version,
      version,
      commit: "abc123",
      artifactSha256: "sha256",
      artifactSha512: "sha512",
      feed: { owner: "nickleuze", repo: "t3code" },
      acceptanceScope: "Feature works",
      targets: [{ environmentId, label: "Studio", role: "remote" }],
      approvedAt,
    },
    environmentId,
    role: "remote",
    status: overrides.status ?? "preparing",
    step: overrides.step ?? "preflight",
    reason: null,
    from: null,
    runtime: null,
    milestones: {
      approvedAt,
      publishedAt: null,
      installedAt: null,
      verifiedAt: null,
      acceptedAt: null,
      ...overrides.milestones,
    },
    admission: null,
    backup: null,
    acceptance: null,
    updatedAt: overrides.updatedAt ?? approvedAt,
  };
}

describe("latestHostDeployment", () => {
  it("returns null without records", () => {
    expect(latestHostDeployment([])).toBeNull();
  });

  it("picks the most recently approved release regardless of order or updates", () => {
    const older = presentationRecord({
      version: "1.1.0",
      approvedAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-10-05T10:00:00.000Z",
    });
    const newer = presentationRecord({ version: "1.2.0", approvedAt: "2026-10-01T10:00:00.000Z" });
    expect(latestHostDeployment([newer, older])?.request.version).toBe("1.2.0");
    expect(latestHostDeployment([older, newer])?.request.version).toBe("1.2.0");
  });
});

describe("hostDeploymentStatusLabel", () => {
  it.each([
    ["preparing", "preflight", "Preparing"],
    ["preparing", "download", "Downloading"],
    ["waiting", "idle", "Waiting for idle"],
    ["waiting", "admission", "Waiting for remotes"],
    ["installing", "commit", "Installing"],
    ["verified", "verify", "Verified"],
    ["accepted", "verify", "Accepted"],
    ["blocked", "backup", "Blocked"],
    ["failed", "verify", "Failed"],
    ["cancelled", "idle", "Cancelled"],
  ] as const)("labels %s at %s as %s", (status, step, expected) => {
    expect(hostDeploymentStatusLabel(presentationRecord({ status, step }))).toBe(expected);
  });
});

describe("hostDeploymentMilestones", () => {
  it("lists every milestone in order and marks the reached ones", () => {
    const view = hostDeploymentMilestones(
      presentationRecord({
        status: "verified",
        milestones: {
          publishedAt: "2026-10-01T11:00:00.000Z",
          installedAt: "2026-10-01T12:00:00.000Z",
          verifiedAt: "2026-10-01T12:05:00.000Z",
        },
      }),
    );
    expect(view).toEqual([
      { label: "Approved", reached: true },
      { label: "Published", reached: true },
      { label: "Installed", reached: true },
      { label: "Verified", reached: true },
      { label: "Accepted", reached: false },
    ]);
  });
});
