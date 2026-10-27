import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  TicketId,
  type WorkModelProjectOptions,
  type WorkModelProjectPreview,
} from "@t3tools/contracts";
import { act, render as renderUi, type Screen } from "../../../test/render";
import { WorkModelProjectHost } from "./WorkModelProjectHost";
import { openWorkModelProject, useWorkModelProject } from "../../workModelProject";

const boundary = vi.hoisted(() => ({
  options: new Map<
    string,
    { data: WorkModelProjectOptions | null; error: string | null; isPending: boolean }
  >(),
  review: vi.fn(),
  create: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  capture: vi.fn(),
  allowed: true,
  publishAllowed: true,
  connected: true,
  groupReady: true,
  github: null as { account: string | null } | null,
  version: 0,
  listeners: new Set<() => void>(),
}));
/** Mocked hooks re-read the boundary when a test changes it, like the atoms they replace. */
function useBoundary() {
  useSyncExternalStore(
    (listener) => {
      boundary.listeners.add(listener);
      return () => boundary.listeners.delete(listener);
    },
    () => boundary.version,
  );
  return boundary;
}
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  // Permission atoms are tokens, so a memoized atom read still sees a changed grant.
  useAtomValue: (atom: string) => {
    const { allowed, publishAllowed } = useBoundary();
    return atom === "create-permission" ? allowed : publishAllowed;
  },
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => boundary.navigate,
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    workModelOptions: ({ environmentId }: { environmentId: string }) => ({ environmentId }),
    createNew: { permissionAtom: () => "create-permission" },
    workModelPreview: {},
  },
}));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    discovery: () => null,
    publishRepository: { permissionAtom: () => "publish-permission" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { environmentId: string } | null) => {
    const current = useBoundary();
    return {
      // Source control discovery (null query) gets fresh data, so publish targets are re-read.
      ...(query
        ? current.options.get(query.environmentId)
        : { data: { version: current.version }, error: null, isPending: false }),
      refresh: current.refresh,
    };
  },
}));
vi.mock("@t3tools/client-runtime/operations/projects", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/operations/projects")>()),
  getNewProjectPublishTargets: () =>
    boundary.github ? [{ definition: { kind: "github" }, owner: boundary.github.account }] : [],
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => boundary.review }));
vi.mock("../../hooks/useNewProject", () => ({ useNewProject: () => boundary.create }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../ticketCapture", () => ({
  openTicketCapture: (...args: unknown[]) => boundary.capture(...args),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    revision: useBoundary().version,
    environments: [
      {
        environmentId: "A",
        label: "Mac A",
        connection: { phase: boundary.connected ? "connected" : "disconnected" },
        serverConfig: { newProjectsRoot: "/A/basic" },
      },
      {
        environmentId: "B",
        label: "Mac B",
        connection: { phase: "connected" },
        serverConfig: { newProjectsRoot: "/B/basic" },
      },
    ],
  }),
}));
vi.mock("../settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () =>
    boundary.groupReady
      ? [
          {
            projectKey: "ui-group",
            displayName: "Fixture",
            memberProjects: [{ environmentId: "A", id: "registration" }],
          },
        ]
      : [],
}));
vi.mock("../tickets/TicketPicker", () => ({
  TicketPicker: ({
    label,
    value,
    options,
    onChange,
    disabled,
  }: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    disabled: boolean;
  }) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const options: WorkModelProjectOptions = {
  projectsRoot: "/A/Projects",
  areas: [{ name: "systems", scope: "personal" }],
  initializerAvailable: true,
};
const preview: WorkModelProjectPreview = {
  workspaceRoot: "/A/Projects/systems/fixture",
  projectIdentity: "fixture",
  projectKey: "fixture",
  scope: "personal",
  existingHome: false,
  registeredProjectId: null,
  files: [],
};
let screen: Screen | undefined;
/** Resets the boundary and request for one test; disposing unmounts the host. */
function setup(): AsyncDisposable {
  boundary.options.clear();
  boundary.options.set("A", { data: options, error: null, isPending: false });
  boundary.options.set("B", {
    data: {
      ...options,
      projectsRoot: "/B/Projects",
      areas: [{ name: "creative", scope: "personal" }],
    },
    error: null,
    isPending: false,
  });
  for (const mock of [
    boundary.review,
    boundary.create,
    boundary.refresh,
    boundary.navigate,
    boundary.capture,
  ])
    mock.mockReset();
  boundary.review.mockResolvedValue({ _tag: "Success", value: preview });
  boundary.create.mockResolvedValue({
    projectId: ProjectId.make("registration"),
    workspaceRoot: preview.workspaceRoot,
  });
  boundary.allowed = true;
  boundary.publishAllowed = true;
  boundary.connected = true;
  boundary.groupReady = true;
  boundary.github = null;
  openWorkModelProject({
    environmentId: EnvironmentId.make("A"),
    name: "Fixture",
    purpose: "Build a useful thing",
  });
  return {
    async [Symbol.asyncDispose]() {
      await screen?.unmount();
      await act(() => useWorkModelProject.setState({ request: null }));
      await screen?.[Symbol.asyncDispose]();
      screen = undefined;
    },
  };
}
/** Mounts the host on first call; later calls publish the boundary's changes. */
const render = async () => {
  if (!screen) {
    screen = await renderUi(<WorkModelProjectHost />);
    return;
  }
  await act(() => {
    boundary.version += 1;
    for (const listener of boundary.listeners) listener();
  });
};
const button = (text: string) => {
  const node = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!node) throw new Error(`Missing button: ${text}`);
  return node;
};
const click = (text: string) => act(async () => button(text).click());
const choose = (label: string, value: string) =>
  act(async () => {
    const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
const input = (label: string) => {
  const node = Array.from(document.querySelectorAll("label"))
    .find((l) => l.querySelector("span")?.textContent === label)
    ?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
  if (!node) throw new Error(`Missing input: ${label}`);
  return node;
};
const change = (label: string, value: string) =>
  act(async () => {
    const node = input(label);
    const prototype =
      node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
const review = async () => {
  await render();
  await choose("Area", "systems");
  await click("Review setup");
};

it("reviews the single setup form before creating; opens settings honestly and leaves the first Ticket separate", async () => {
  await using _setup = setup();
  await render();
  expect(input("Name").value).toBe("Fixture");
  await change("Name", "My Home");
  await choose("Area", "systems");
  await click("Review setup");
  expect(boundary.create).not.toHaveBeenCalled();
  expect(boundary.review).toHaveBeenCalledWith({
    environmentId: "A",
    input: {
      name: "My Home",
      area: "systems",
      slug: "my-home",
      purpose: "Build a useful thing",
      adoptExisting: false,
    },
  });
  await click("Back");
  expect(input("Name").value).toBe("My Home");
  await click("Review setup");
  await click("Create project");
  expect(boundary.create).toHaveBeenCalledTimes(1);
  expect(boundary.capture).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("No work has started");
  await click("Project settings");
  expect(boundary.navigate).toHaveBeenCalledWith({
    to: "/settings/projects",
    search: { project: "ui-group", machine: "A" },
  });
  expect(useWorkModelProject.getState().request).toBeNull();
});
it("preserves an Idea through review and cancellation, then offers a separate first Ticket after success", async () => {
  await using _setup = setup();
  openWorkModelProject({
    environmentId: EnvironmentId.make("A"),
    name: "Idea",
    purpose: "Original purpose",
    sourceIdeaId: TicketId.make("idea"),
  });
  await review();
  await click("Cancel");
  expect(boundary.create).not.toHaveBeenCalled();
  openWorkModelProject({
    environmentId: EnvironmentId.make("A"),
    name: "Idea",
    purpose: "Original purpose",
    sourceIdeaId: TicketId.make("idea"),
  });
  await review();
  await click("Create project");
  expect(boundary.create.mock.calls[0]![0].workModel.sourceIdeaId).toBe("idea");
  await click("Create first Ticket");
  expect(boundary.capture).toHaveBeenCalledWith({
    projectRef: { environmentId: "A", projectId: "registration" },
  });
});
it("shows durable identity separately from a legacy prefix and explicitly adopts an existing Home without an initializer", async () => {
  await using _setup = setup();
  boundary.options.set("A", {
    data: { ...options, initializerAvailable: false },
    error: null,
    isPending: false,
  });
  boundary.review.mockResolvedValue({
    _tag: "Success",
    value: {
      ...preview,
      existingHome: true,
      projectKey: "legacy-t3-fixture",
      registeredProjectId: ProjectId.make("registration"),
    },
  });
  await render();
  expect(document.body.textContent).toContain("missing project-init");
  await choose("Area", "systems");
  await click("Review setup");
  expect(document.body.textContent).toContain("Project identity (README)fixture");
  expect(document.body.textContent).toContain("Ticket ID prefixlegacy-t3-fixture");
  await click("Adopt existing Home");
  expect(boundary.create.mock.calls[0]![0].workModel.adoptExisting).toBe(true);
});
it("labels identity unavailable on older servers without substituting a legacy prefix", async () => {
  await using _setup = setup();
  const { projectIdentity: _, ...legacy } = preview;
  boundary.review.mockResolvedValue({ _tag: "Success", value: legacy });
  await review();
  expect(document.body.textContent).toContain("Not reported by this server");
});
it.each(["no-areas", "discovery-failed"])(
  "requires explicit basic creation and review for %s",
  async (reason) => {
    await using _setup = setup();
    boundary.options.set("A", {
      data: reason === "no-areas" ? { ...options, areas: [] } : options,
      error: reason === "discovery-failed" ? "unavailable" : null,
      isPending: false,
    });
    await render();
    expect(button("Review setup").disabled).toBe(true);
    await click("Use basic creation");
    await click("Review setup");
    expect(boundary.review).not.toHaveBeenCalled();
    expect(boundary.create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("/A/basic/fixture");
    await click("Create basic project");
    expect(boundary.create).toHaveBeenCalledWith({
      environmentId: "A",
      name: "Fixture",
      publishTo: null,
    });
  },
);
it("does not silently convert an Idea to basic creation when setup is missing", async () => {
  await using _setup = setup();
  openWorkModelProject({
    environmentId: EnvironmentId.make("A"),
    name: "Idea",
    purpose: "Keep",
    sourceIdeaId: TicketId.make("idea"),
  });
  boundary.options.set("A", { data: { ...options, areas: [] }, error: null, isPending: false });
  await render();
  expect(button("Review setup").disabled).toBe(true);
  expect(document.body.textContent).toContain("The Idea stays unchanged");
  expect(document.body.textContent).not.toContain("Use basic creation");
});
it("keeps name and purpose when switching machines, resets Area and routes review to the selected host", async () => {
  await using _setup = setup();
  await render();
  await choose("Area", "systems");
  await change("Name", "Keep this name");
  await choose("Destination machine", "B");
  expect(input("Name").value).toBe("Keep this name");
  expect(button("Review setup").disabled).toBe(true);
  await choose("Area", "creative");
  await click("Review setup");
  expect(boundary.review.mock.calls[0]![0]).toMatchObject({
    environmentId: "B",
    input: { name: "Keep this name", area: "creative", purpose: "Build a useful thing" },
  });
});
it("does not create when permission or connectivity is lost after review", async () => {
  await using _setup = setup();
  await review();
  boundary.allowed = false;
  await render();
  expect(button("Create project").disabled).toBe(true);
  boundary.allowed = true;
  boundary.connected = false;
  await render();
  expect(button("Create project").disabled).toBe(true);
  expect(boundary.create).not.toHaveBeenCalled();
});
it("retains input and requires another review after creation fails", async () => {
  await using _setup = setup();
  boundary.create.mockResolvedValue(null);
  await review();
  await click("Create project");
  expect(input("Name").value).toBe("Fixture");
  expect(input("Purpose").value).toBe("Build a useful thing");
  expect(document.body.textContent).toContain("Review the same Home to resume");
  expect(button("Review setup").disabled).toBe(false);
});
it("allows retrying setup without clearing the form", async () => {
  await using _setup = setup();
  boundary.options.set("A", { data: null, error: "Unavailable", isPending: false });
  await render();
  await click("Retry setup");
  expect(boundary.refresh).toHaveBeenCalledTimes(1);
  expect(input("Name").value).toBe("Fixture");
});
it("guards duplicate submits while review is pending", async () => {
  await using _setup = setup();
  let finish!: (result: unknown) => void;
  boundary.review.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await choose("Area", "systems");
  await act(async () => {
    const form = document.querySelector("form")!;
    for (let i = 0; i < 2; i++)
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(boundary.review).toHaveBeenCalledTimes(1);
  expect(button("Cancel").disabled).toBe(true);
  await act(async () => finish({ _tag: "Success", value: preview }));
});
it("reviews optional GitHub publication and rejects an account change before creation", async () => {
  await using _setup = setup();
  boundary.github = { account: "account-a" };
  await render();
  await choose("Area", "systems");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  await click("Review setup");
  expect(document.body.textContent).toContain("Create private repository: account-a/fixture");
  boundary.github = { account: "account-b" };
  await render();
  await click("Create project");
  expect(boundary.create).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("GitHub availability changed");
});
it("does not offer a duplicate creation when registration has not reached the client", async () => {
  await using _setup = setup();
  boundary.groupReady = false;
  await review();
  await click("Create project");
  expect(document.body.textContent).toContain("Waiting for this client");
  expect(button("Project settings").disabled).toBe(true);
  await click("Close");
  expect(boundary.create).toHaveBeenCalledTimes(1);
});

it("does not publish when adopting an existing Home, even after the option was selected", async () => {
  await using _setup = setup();
  boundary.github = { account: "account-a" };
  boundary.review.mockResolvedValue({ _tag: "Success", value: { ...preview, existingHome: true } });
  await render();
  await choose("Area", "systems");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  await click("Review setup");
  expect(document.body.textContent).toContain("Not offered when adopting");
  await click("Adopt existing Home");
  expect(boundary.create.mock.calls[0]![0].publishTo).toBeNull();
});
it("distinguishes a failed basic request from resumable Home adoption", async () => {
  await using _setup = setup();
  boundary.options.set("A", { data: { ...options, areas: [] }, error: null, isPending: false });
  boundary.create.mockResolvedValue(null);
  await render();
  await click("Use basic creation");
  await click("Review setup");
  await click("Create basic project");
  expect(document.body.textContent).toContain("Check the project list before retrying");
  expect(document.body.textContent).not.toContain("Review the same Home to resume");
});
it("explains a setup change after review and prevents silently changing creation modes", async () => {
  await using _setup = setup();
  await review();
  boundary.options.set("A", { data: options, error: "refresh failed", isPending: false });
  await render();
  expect(button("Create project").disabled).toBe(true);
  expect(document.body.textContent).toContain("Setup changed since review");
  await click("Back");
  expect(input("Name").value).toBe("Fixture");
  expect(boundary.create).not.toHaveBeenCalled();
});
it("explains a missing publication grant even when GitHub is configured", async () => {
  await using _setup = setup();
  boundary.github = { account: "ready" };
  boundary.publishAllowed = false;
  await render();
  expect(document.body.textContent).toContain("This connection cannot publish repositories");
  expect(document.querySelector('[role="checkbox"]')).toBeNull();
});
