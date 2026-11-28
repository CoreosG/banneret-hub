// Banneret Hub: "No project" in the sidebar with two machines. Their No project homes are one
// folder; another project with the same title says where it is. The sidebar sits in its frame, at
// the default width the app gives it.
import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import Sidebar from "../components/Sidebar";
import { Sidebar as SidebarFrame, SidebarProvider } from "../components/ui/sidebar";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import {
  expectClickable,
  expectInside,
  expectNoOverlap,
  expectNoPageScroll,
  forEachViewport,
  numbered,
  windowRect,
} from "./test/viewports";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../components/sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

// The desktop sidebar: below 768px it is a sheet that starts closed.
await page.viewport(900, 700);

const PC = EnvironmentId.make("pc");
const WSL = EnvironmentId.make("wsl");

function noProject(
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot: string,
  isScratch: boolean,
): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "No project",
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...(isScratch ? { isScratch: true as const } : {}),
  };
}

/** Folders and rows stay inside the sidebar, one per line; a name too long ends in an ellipsis. */
function expectSidebarLayout() {
  expectNoPageScroll();
  const frame = document.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect();
  expect([frame.left, frame.top, frame.width, frame.bottom]).toEqual([
    0,
    0,
    256,
    window.innerHeight,
  ]);
  const rows = [...document.querySelectorAll("[data-sidebar-row]")];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expectInside(row, frame, "a sidebar row");
  expectNoOverlap(numbered("sidebar row", rows));
  for (const folder of document.querySelectorAll('[data-testid="sidebar-project-folder"]')) {
    const button = folder.querySelector("button")!;
    const name = button.querySelector<HTMLElement>(".truncate")!;
    const chevron = button.querySelector(":scope > svg:last-child")!;
    expectInside(name, button.getBoundingClientRect(), "the folder name");
    expectNoOverlap({ "the folder name": name, "the chevron": chevron });
    expectClickable(button, "the folder");
    if (name.scrollWidth > name.clientWidth) {
      expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
      // Machine names this short are never cut.
      expect(name.textContent).not.toMatch(/· (PC|WSL)$/);
    }
  }
}

async function expectFolderMenu() {
  const button = document.querySelector<HTMLElement>(
    '[data-testid="sidebar-project-folder"] button',
  )!;
  await userEvent.click(button, { button: "right" });
  await expect.element(page.getByRole("menu")).toBeVisible();
  await vi.waitFor(() => {
    expectInside(page.getByRole("menu").element(), windowRect(), "the folder menu");
    expectClickable(
      page.getByRole("menuitem", { name: "Project settings" }).element(),
      "Project settings",
    );
  });
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
}

async function folderNames(
  projects: ReadonlyArray<Project>,
  /** Runs while the sidebar is up. */
  whileShown?: () => Promise<void>,
) {
  const stack = new DisposableStack();
  const previous = getClientSettings();
  stack.defer(() => __setClientSettingsForTests(previous));
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: true });
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(PC);
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([PC, WSL]);
  vi.mocked(useEnvironmentIdentities).mockReturnValue([
    { environmentId: PC, label: "PC" },
    { environmentId: WSL, label: "WSL" },
  ] as ReturnType<typeof useEnvironmentIdentities>);
  vi.mocked(useProjects).mockReturnValue(projects as Project[]);
  vi.mocked(useQuietThreadShells).mockReturnValue(
    projects.map((project) =>
      makeThreadFixture({
        environmentId: project.environmentId,
        id: ThreadId.make(`thread-${project.id}`),
        projectId: project.id,
        title: `Work in ${project.id}`,
      }),
    ),
  );
  const screen = await render(
    <SidebarProvider>
      <SidebarFrame side="left" collapsible="offcanvas">
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarFrame>
    </SidebarProvider>,
  );
  await expect.element(screen.getByTestId("sidebar-project-folder").first()).toBeVisible();
  const names = [...document.querySelectorAll('[data-testid="sidebar-project-folder"]')].map(
    (folder) => folder.querySelector("button .truncate")!.textContent,
  );
  await vi.waitFor(expectSidebarLayout);
  await expectFolderMenu();
  await whileShown?.();
  await screen.unmount();
  stack.dispose();
  return names.toSorted();
}

// The two cases with the longest names: machine labels that are never cut, and a path that is.
forEachViewport("No project folders stay inside the sidebar", async (at) => {
  await folderNames(
    [
      noProject(PC, "pc-home", "C:\\Users\\a\\.banneret\\scratch", true),
      noProject(WSL, "wsl-stray", "/home/a/.t3/scratch", false),
    ],
    () => at.screenshot("machines"),
  );
  await folderNames(
    [
      noProject(WSL, "wsl-home", "/home/a/.banneret/scratch", true),
      noProject(WSL, "wsl-stray", "/home/a/.t3/scratch", false),
    ],
    () => at.screenshot("path"),
  );
});

describe("No project folders across two machines", () => {
  it("are one folder, with no machine label, when both are No project homes", async () => {
    expect(
      await folderNames([
        noProject(PC, "pc-home", "C:\\Users\\a\\.banneret\\scratch", true),
        noProject(WSL, "wsl-home", "/home/a/.banneret/scratch", true),
      ]),
    ).toEqual(["No project"]);
  });

  it("name their machines when one of them is not its machine's home", async () => {
    expect(
      await folderNames([
        noProject(PC, "pc-home", "C:\\Users\\a\\.banneret\\scratch", true),
        noProject(WSL, "wsl-stray", "/home/a/.t3/scratch", false),
      ]),
    ).toEqual(["No project · PC", "No project · WSL"]);
  });

  it("name their machines when neither is known to be a home", async () => {
    expect(
      await folderNames([
        noProject(PC, "pc-stray", "C:\\Users\\a\\.t3\\scratch", false),
        noProject(WSL, "wsl-stray", "/home/a/.t3/scratch", false),
      ]),
    ).toEqual(["No project · PC", "No project · WSL"]);
  });

  it("show the folder of a second one on the same machine", async () => {
    expect(
      await folderNames([
        noProject(WSL, "wsl-home", "/home/a/.banneret/scratch", true),
        noProject(WSL, "wsl-stray", "/home/a/.t3/scratch", false),
      ]),
    ).toEqual(["No project", "No project · /home/a/.t3/scratch"]);
  });
});
