// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  ProjectId,
  type WorkModelProjectOptions,
} from "@t3tools/contracts";
import { AddProjectNewScreen } from "./AddProjectScreen";

const state = vi.hoisted(() => ({
  setup: null as WorkModelProjectOptions | null,
  error: null as string | null,
  connected: true,
  allowed: true,
  github: null as { account: string | null } | null,
  create: vi.fn(),
  review: vi.fn(),
  refresh: vi.fn(),
  dispatch: vi.fn(),
  goBack: vi.fn(),
  publish: vi.fn(),
  wait: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "fixture" }));
vi.mock("@t3tools/client-runtime/operations/projects", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/operations/projects")>()),
  getNewProjectGitHubTarget: () => state.github,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Alert: { alert: vi.fn() },
  ActivityIndicator: () => <span>Working…</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    editable,
  }: {
    value: string;
    onChangeText: (s: string) => void;
    accessibilityLabel: string;
    editable: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      disabled={!editable}
      onChange={(e) => onChangeText(e.target.value)}
    />
  ),
}));
vi.mock("../../components/MaterialListRow", () => ({ MaterialListRow: () => null }));
vi.mock("../../components/MaterialButton", () => ({ MaterialButton: () => null }));
vi.mock("../../components/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({ children, title }: { children: ReactNode; title: string }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));
vi.mock("../../components/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: state.dispatch, canGoBack: () => true, goBack: state.goBack }),
  CommonActions: { reset: (v: unknown) => v },
  StackActions: { replace: (v: unknown) => v },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ErrorBanner", () => ({
  ErrorBanner: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));
vi.mock("../../components/SourceControlIcon", () => ({ SourceControlIcon: () => null }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_id: string, scope: string) =>
    (scope === AuthOrchestrationOperateScope || scope === AuthSourceControlWriteScope) &&
    state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  waitForProject: (...args: unknown[]) => state.wait(...args),
  useServerConfigs: () =>
    new Map(
      ["A", "B"].map((id) => [
        id,
        {
          newProjectsRoot: `/${id}/basic`,
          environment: { platform: { os: "linux" }, capabilities: {} },
          settings: {},
        },
      ]),
    ),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({}),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      { environmentId: "A", connectionState: state.connected ? "connected" : "offline" },
      { environmentId: "B", connectionState: "connected" },
    ],
  }),
  useSavedRemoteConnections: () => ({
    savedConnectionsById: {
      A: { environmentId: "A", environmentLabel: "Mac A" },
      B: { environmentId: "B", environmentLabel: "Mac B" },
    },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => () => {} }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { environmentId: string } | null) => ({
    data: query ? state.setup : null,
    error: query ? state.error : null,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/filesystem", () => ({ filesystemEnvironment: {} }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    discovery: () => null,
    publishRepository: (...args: unknown[]) => state.publish(...args),
  },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    createNew: (...args: unknown[]) => state.create(...args),
    workModelPreview: (...args: unknown[]) => state.review(...args),
    workModelOptions: (v: unknown) => v,
  },
}));

const options: WorkModelProjectOptions = {
  projectsRoot: "/A/Projects",
  areas: [{ name: "systems", scope: "personal" }],
  initializerAvailable: true,
};
const preview = {
  workspaceRoot: "/A/Projects/systems/fixture",
  projectIdentity: "fixture",
  projectKey: "legacy-prefix",
  scope: "personal",
  existingHome: false,
  registeredProjectId: null,
  files: [],
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.setup = options;
  state.error = null;
  state.connected = true;
  state.allowed = true;
  state.github = null;
  for (const mock of [
    state.create,
    state.review,
    state.refresh,
    state.dispatch,
    state.goBack,
    state.publish,
    state.wait,
  ])
    mock.mockReset();
  state.review.mockResolvedValue(AsyncResult.success(preview));
  state.create.mockResolvedValue(
    AsyncResult.success({
      projectId: ProjectId.make("registration"),
      workspaceRoot: preview.workspaceRoot,
    }),
  );
  state.wait.mockResolvedValue({ id: "registration" });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (environmentId = "A") =>
  act(async () => root.render(<AddProjectNewScreen environmentId={environmentId} />));
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
};
const click = (label: string) => act(async () => button(label).click());
const change = (label: string, value: string) =>
  act(async () => {
    const node = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
const prepare = async () => {
  await render();
  await change("Project name", "Fixture");
  await click("systems");
  await change("Purpose", "Build it");
};

it("reviews before creation, shows identity and prefix, and offers first Ticket separately", async () => {
  await prepare();
  await click("Review setup");
  expect(state.create).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Project identity (README): fixture");
  expect(container.textContent).toContain("Ticket ID prefix: legacy-prefix");
  await click("Back");
  expect(container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!.value).toBe(
    "Fixture",
  );
  await click("Review setup");
  await click("Create project");
  expect(state.create).toHaveBeenCalledWith({
    environmentId: "A",
    input: {
      name: "Fixture",
      workModel: { area: "systems", slug: "fixture", purpose: "Build it", adoptExisting: false },
    },
  });
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(container.textContent).toContain("No work has started");
  state.connected = false;
  await render();
  expect(container.textContent).toContain("Registered in T3 on Mac A");
  await click("Done");
  expect(state.goBack).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  "requires explicit basic fallback and review (discovery failure: %s)",
  async (failed) => {
    state.setup = { ...options, areas: [] };
    state.error = failed ? "unavailable" : null;
    await render();
    await change("Project name", "Fixture");
    expect(button("Review setup").disabled).toBe(true);
    await click("Use basic creation");
    await click("Review setup");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.review).not.toHaveBeenCalled();
    expect(container.textContent).toContain("/A/basic/fixture");
    await click("Create basic project");
    expect(state.create).toHaveBeenCalledWith({ environmentId: "A", input: { name: "Fixture" } });
  },
);
it("keeps adoption available without an initializer and preserves the form after failure", async () => {
  state.setup = { ...options, initializerAvailable: false };
  state.review.mockResolvedValue(AsyncResult.success({ ...preview, existingHome: true }));
  state.create.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new Error("Registration failed; Home preserved"))),
  );
  await prepare();
  expect(container.textContent).toContain("missing project-init");
  await click("Review setup");
  await click("Adopt existing Home");
  expect(state.create.mock.calls[0]![0].input.workModel.adoptExisting).toBe(true);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!.value).toBe(
    "Fixture",
  );
  expect(container.textContent).toContain("Home preserved");
});
it("does not redirect a reviewed create to another machine when the destination disconnects", async () => {
  await prepare();
  await click("Review setup");
  state.connected = false;
  await render();
  expect(state.create).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Create project");
  await click("Mac B");
  expect(button("Review setup").disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!.value).toBe(
    "Fixture",
  );
});
it("requires another review if basic setup becomes a Work Model host", async () => {
  state.setup = { ...options, areas: [] };
  await render();
  await change("Project name", "Fixture");
  await click("Use basic creation");
  await click("Review setup");
  state.setup = options;
  await render();
  expect(button("Create basic project").disabled).toBe(true);
  expect(container.textContent).toContain("Setup changed since review");
  expect(state.create).not.toHaveBeenCalled();
});
it("blocks confirmation after permission is revoked", async () => {
  await prepare();
  await click("Review setup");
  state.allowed = false;
  await render();
  expect(button("Create project").disabled).toBe(true);
  expect(state.create).not.toHaveBeenCalled();
});
it("does not publish an adopted Home even when publication was selected before review", async () => {
  state.github = { account: "account-a" };
  state.review.mockResolvedValue(AsyncResult.success({ ...preview, existingHome: true }));
  await prepare();
  await click("Create private repository on GitHub");
  await click("Review setup");
  expect(container.textContent).toContain("Not offered when adopting");
  await click("Adopt existing Home");
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.publish).not.toHaveBeenCalled();
});
