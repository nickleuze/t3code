import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type HostDeployment, type HostDeploymentRequest } from "@t3tools/contracts";

import {
  buildReleaseDeploymentRequest,
  currentReleaseRequest,
  deploymentRowActions,
  deploymentRows,
  environmentDeploymentStatus,
  localOnlyOverride,
  orderReleaseTargets,
  releaseDeploymentEligible,
  releaseRecords,
  releaseSuperseded,
  releaseTargetSequence,
  releaseToResume,
} from "./releaseDeployment.logic";

const mini = EnvironmentId.make("mini");
const studio = EnvironmentId.make("studio");
const mac = EnvironmentId.make("mac");

const manifest = {
  version: "1.4.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  artifactSha256: "a".repeat(64),
  artifactSha512: "b".repeat(128),
  feed: { owner: "nickleuze", repo: "t3code" },
};

const request: HostDeploymentRequest = buildReleaseDeploymentRequest({
  manifest,
  targets: orderReleaseTargets(
    [
      { environmentId: mini, serverLabel: "Mini" },
      { environmentId: studio, serverLabel: "Studio" },
    ],
    mac,
  ),
  approvedAt: "2026-10-17T10:00:00.000Z",
});

function record(
  environmentId: EnvironmentId,
  overrides: Partial<HostDeployment> = {},
): HostDeployment {
  const target = request.targets.find((entry) => entry.environmentId === environmentId)!;
  return {
    request,
    environmentId,
    role: target.role,
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

const allConnected = new Set<string>([mini, studio, mac]);
const waitingLocal = record(mac, { status: "waiting", step: "admission" });

describe("releaseDeploymentEligible", () => {
  const base = {
    hasManifestBridge: true,
    localSupported: true,
    canRequestLocally: true,
    hasLocalUpdate: true,
    remotesSupported: [true],
  };

  it("needs the bridge, the local host and every remote to support deployments", () => {
    expect(releaseDeploymentEligible(base)).toBe(true);
    expect(releaseDeploymentEligible({ ...base, hasManifestBridge: false })).toBe(false);
    expect(releaseDeploymentEligible({ ...base, localSupported: false })).toBe(false);
    expect(releaseDeploymentEligible({ ...base, remotesSupported: [true, false] })).toBe(false);
  });

  it("needs something to deploy", () => {
    expect(
      releaseDeploymentEligible({ ...base, hasLocalUpdate: false, remotesSupported: [] }),
    ).toBe(false);
    expect(releaseDeploymentEligible({ ...base, hasLocalUpdate: false })).toBe(true);
  });
});

describe("buildReleaseDeploymentRequest", () => {
  it("orders remotes before this machine and pins the manifest identity", () => {
    expect(request.releaseId).toBe("1.4.0");
    expect(request.automaticAcceptance).toBe(true);
    expect(request.commit).toBe(manifest.commit);
    expect(request.artifactSha512).toBe(manifest.artifactSha512);
    expect(releaseTargetSequence(request.targets)).toBe("Mini → Studio → This machine");
    expect(request.targets.map((target) => target.role)).toEqual(["remote", "remote", "local"]);
  });

  it("rejects an empty target list", () => {
    expect(() =>
      buildReleaseDeploymentRequest({
        manifest,
        targets: [],
        approvedAt: request.approvedAt,
      }),
    ).toThrow();
  });
});

describe("currentReleaseRequest", () => {
  const now = Date.parse("2026-10-17T12:00:00.000Z");

  it("shows an unfinished release", () => {
    const records = new Map([[mac, [waitingLocal]]]);
    expect(currentReleaseRequest(records, now)?.releaseId).toBe("1.4.0");
  });

  it("hides a release that finished more than a day ago", () => {
    const old = record(mac, { status: "accepted", updatedAt: "2026-10-15T10:00:00.000Z" });
    expect(currentReleaseRequest(new Map([[mac, [old]]]), now)).toBeNull();
    const recent = record(mac, { status: "accepted", updatedAt: "2026-10-17T11:00:00.000Z" });
    expect(currentReleaseRequest(new Map([[mac, [recent]]]), now)?.releaseId).toBe("1.4.0");
  });
});

describe("releaseSuperseded", () => {
  const stopped = releaseRecords(
    request,
    new Map([
      [mini, [record(mini, { status: "verified" })]],
      [mac, [record(mac, { status: "blocked", reason: "The update feed now offers 1.4.1." })]],
    ]),
  );

  it("lets a newer published version replace a release no host is moving on", () => {
    expect(releaseSuperseded(request, stopped, "1.4.1")).toBe(true);
    expect(releaseSuperseded(request, stopped, "1.4.0")).toBe(false);
  });

  it("keeps a release while any host is still deploying it", () => {
    const moving = new Map(stopped).set(studio, record(studio, { status: "installing" }));
    expect(releaseSuperseded(request, moving, "1.4.1")).toBe(false);
  });
});

describe("deploymentRowActions", () => {
  it("offers retry for stopped, acceptance for verified and cancel before the hand-off", () => {
    expect(deploymentRowActions(record(mini, { status: "failed" }))).toEqual(["retry"]);
    expect(deploymentRowActions(record(mini, { status: "blocked" }))).toEqual(["retry"]);
    expect(deploymentRowActions(record(mini, { status: "verified" }))).toEqual(["accept"]);
    expect(deploymentRowActions(record(mini, { status: "waiting", step: "idle" }))).toEqual([
      "cancel",
    ]);
    expect(deploymentRowActions(record(mini, { status: "installing", step: "commit" }))).toEqual(
      [],
    );
    expect(deploymentRowActions(record(mini, { status: "accepted" }))).toEqual([]);
  });
});

describe("deploymentRows", () => {
  it("reports offline hosts without actions and falls back to this client's error", () => {
    const records = releaseRecords(
      request,
      new Map([
        [mini, [record(mini, { status: "failed", reason: "Disk full." })]],
        [mac, [waitingLocal]],
      ]),
    );
    const rows = deploymentRows({
      request,
      records,
      connectedIds: new Set([studio, mac]),
      runErrors: { [studio]: "Release 1.3.0 is already deploying on this host." },
    });
    expect(rows.map((row) => row.label)).toEqual(["Mini", "Studio", "This machine"]);
    expect(rows[0]).toMatchObject({
      offline: "Mini is offline",
      reason: "Disk full.",
      actions: [],
    });
    expect(rows[1]).toMatchObject({
      statusText: "Not started",
      reason: "Release 1.3.0 is already deploying on this host.",
    });
    expect(rows[2]).toMatchObject({ statusText: "Waiting for remotes", actions: ["cancel"] });
  });
});

describe("localOnlyOverride", () => {
  it("is unavailable while every remote can still verify", () => {
    const records = releaseRecords(
      request,
      new Map([
        [mini, [record(mini, { status: "installing", step: "verify" })]],
        [studio, [record(studio, { status: "verified" })]],
        [mac, [waitingLocal]],
      ]),
    );
    expect(localOnlyOverride({ request, records, connectedIds: allConnected })).toBeNull();
  });

  it("names failed and offline remotes in the confirmation and evidence", () => {
    const records = releaseRecords(
      request,
      new Map([
        [mini, [record(mini, { status: "failed", reason: "Signature mismatch." })]],
        [mac, [waitingLocal]],
      ]),
    );
    const override = localOnlyOverride({ request, records, connectedIds: new Set([mini, mac]) });
    expect(override?.evidence).toBe(
      "Installed on this machine without verified remotes: Mini is failed: Signature mismatch.; Studio is offline.",
    );
    expect(override?.confirmation).toContain("Install 1.4.0 on this machine without its remotes?");
  });

  it("needs the local host to wait at admission", () => {
    const records = releaseRecords(
      request,
      new Map([
        [mini, [record(mini, { status: "failed" })]],
        [mac, [record(mac, { status: "preparing", step: "download" })]],
      ]),
    );
    expect(localOnlyOverride({ request, records, connectedIds: allConnected })).toBeNull();
  });
});

describe("releaseToResume", () => {
  it("resumes an unadmitted local record only", () => {
    expect(releaseToResume([waitingLocal])?.releaseId).toBe("1.4.0");
    expect(
      releaseToResume([
        record(mac, {
          status: "installing",
          step: "backup",
          admission: { mode: "remotes-verified", evidence: "ok", at: request.approvedAt },
        }),
      ]),
    ).toBeNull();
    expect(releaseToResume([record(mac, { status: "blocked" })])).toBeNull();
    expect(releaseToResume([record(mini, { status: "waiting", step: "idle" })])).toBeNull();
  });
});

describe("environmentDeploymentStatus", () => {
  it("summarizes the latest record with its reason", () => {
    expect(environmentDeploymentStatus([])).toBeNull();
    expect(
      environmentDeploymentStatus([
        record(mini, { status: "blocked", reason: "Free 4 GiB, then retry." }),
      ]),
    ).toEqual({ text: "1.4.0 · Blocked", reason: "Free 4 GiB, then retry.", stopped: true });
  });
});
