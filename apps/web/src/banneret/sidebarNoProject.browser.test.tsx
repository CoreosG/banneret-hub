// Banneret Hub: "No project" in the sidebar with two machines. Their No project homes are one
// folder; another project with the same title says where it is.
import "../index.css";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import Sidebar from "../components/Sidebar";
import { SidebarProvider } from "../components/ui/sidebar";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../components/sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

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

async function folderNames(projects: ReadonlyArray<Project>) {
  const stack = new DisposableStack();
  const previous = getClientSettings();
  stack.defer(() => __setClientSettingsForTests(previous));
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: true });
  await page.viewport(900, 700);
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
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );
  await expect.element(screen.getByTestId("sidebar-project-folder").first()).toBeVisible();
  const names = [...document.querySelectorAll('[data-testid="sidebar-project-folder"]')].map(
    (folder) => folder.querySelector("button .truncate")!.textContent,
  );
  await screen.unmount();
  stack.dispose();
  return names.toSorted();
}

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
