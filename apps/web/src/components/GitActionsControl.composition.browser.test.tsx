import { EnvironmentId, SourceControlProviderKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { PublishRepositoryDialog } from "./GitActionsControl";

const publish = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("~/state/sourceControl", () => ({
  sourceControlEnvironment: {
    discovery: () => "discovery",
    githubPublishOwners: () => "githubPublishOwners",
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string | null) => {
    if (query === null) return { data: null };
    if (query === "githubPublishOwners") {
      return { data: { account: "work", organizations: ["InMotion-Robotic"] } };
    }
    return {
      data: {
        versionControlSystems: [],
        sourceControlProviders: [
          {
            kind: SourceControlProviderKind.make("github"),
            label: "GitHub",
            status: "available",
            version: Option.none(),
            installHint: "Install gh",
            detail: Option.none(),
            auth: {
              status: "authenticated",
              account: Option.none(),
              host: Option.some("github.com"),
              detail: Option.none(),
            },
          },
        ],
      },
    };
  },
}));

vi.mock("~/state/sourceControlActions", () => ({
  useGitStackedAction: vi.fn(),
  useSourceControlActionRunning: vi.fn(),
  useVcsInitAction: vi.fn(),
  useVcsPullAction: vi.fn(),
  useSourceControlPublishRepositoryAction: () => ({
    isAllowed: true,
    isPending: false,
    run: publish.run,
  }),
}));

function setup() {
  publish.run.mockReset();
  publish.run.mockReturnValue(new Promise(() => {}));
}

it("keeps composition Enter in the repository path from publishing", async () => {
  setup();
  await using _screen = await render(
    <PublishRepositoryDialog
      open
      onOpenChange={() => {}}
      environmentId={EnvironmentId.make("local")}
      threadRef={null}
      gitCwd="/repo"
      offeredProviders={undefined}
    />,
  );
  await page.getByRole("button", { name: "Next" }).click();
  const path = page.getByRole("textbox", { name: "Repository" });
  await path.fill("octo/repo");

  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ...nativeEvent,
      bubbles: true,
      cancelable: true,
    });
    await act(() => path.element().dispatchEvent(event));
    expect(publish.run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  }

  await userEvent.keyboard("{Enter}");
  expect(publish.run).toHaveBeenCalledOnce();
});

it("publishes to the chosen organization while preserving the repository name", async () => {
  setup();
  await using _screen = await render(
    <PublishRepositoryDialog
      open
      onOpenChange={() => {}}
      environmentId={EnvironmentId.make("local")}
      threadRef={null}
      gitCwd="/repo"
      offeredProviders={undefined}
      supportsGitHubPublishOwners
    />,
  );
  await page.getByRole("button", { name: "Next" }).click();
  const path = page.getByRole("textbox", { name: "Repository", exact: true });
  await path.fill("work/robot-demo");
  await page
    .getByRole("combobox", { name: "GitHub repository owner" })
    .selectOptions("InMotion-Robotic");
  await expect.element(path).toHaveValue("InMotion-Robotic/robot-demo");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  expect(publish.run).toHaveBeenCalledWith(
    expect.objectContaining({
      repository: "github.com/InMotion-Robotic/robot-demo",
      visibility: "private",
    }),
  );
});
