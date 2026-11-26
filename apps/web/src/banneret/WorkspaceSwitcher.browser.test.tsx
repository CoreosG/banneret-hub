import appCss from "../index.css?inline";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  mergeBanneretWorkspaces,
  ProjectId,
  ThreadId,
  type BanneretWorkspace,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import {
  useDelegatedUnderParent,
  useProject,
  useProjects,
  useQuietThreadShells,
  useThreadShell,
} from "../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../state/environments";
import type { Project } from "../types";
import { WorkspacesHost } from "./WorkspacesHost";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { loadEnvironmentWorkspaces, useWorkspacesStore, workspacesRpc } from "./workspacesStore";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });

const LOCAL = EnvironmentId.make("local");

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: LOCAL,
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

const projects = [project("alpha"), project("beta"), project("gamma")];

function setup() {
  useWorkspacesStore.setState({
    byEnvironment: {},
    supported: new Set(),
    local: [],
    activeId: null,
    dialog: null,
  });
  // The environment's server: it keeps the newest copy of each workspace.
  let stored: BanneretWorkspace[] = [];
  vi.spyOn(workspacesRpc, "list").mockImplementation(async () => ({ workspaces: stored }));
  vi.spyOn(workspacesRpc, "put").mockImplementation(async (_environmentId, workspaces) => {
    stored = mergeBanneretWorkspaces(stored, workspaces);
    return { workspaces: stored };
  });
  vi.mocked(useProjects).mockReturnValue(projects);
  vi.mocked(useQuietThreadShells).mockReturnValue([]);
  vi.mocked(useDelegatedUnderParent).mockReturnValue(new Set());
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([LOCAL]);
  vi.mocked(useEnvironmentIdentities).mockReturnValue([]);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(LOCAL);
  vi.mocked(useThreadShell).mockReturnValue(null);
  vi.mocked(useProject).mockReturnValue(null);
  return { stored: () => stored };
}

function SidebarHarness() {
  const groups = useSidebarProjectGroups();
  return (
    <>
      <WorkspaceSwitcher onBackdrop={false}>
        <span>Brand</span>
      </WorkspaceSwitcher>
      <ul aria-label="Sidebar projects">
        {groups.map((group) => (
          <li key={group.projectKey}>{group.displayName}</li>
        ))}
      </ul>
      <WorkspacesHost />
    </>
  );
}

// The thread route the app uses, so opening a thread changes the router's params as it does there.
function createThreadRouter() {
  const root = createRootRoute({ component: SidebarHarness });
  const thread = createRoute({ getParentRoute: () => root, path: "/$environmentId/$threadId" });
  return createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    disableGlobalCatchBoundary: true,
  });
}

const sidebarProjects = () => page.getByRole("list", { name: "Sidebar projects" });

describe("WorkspaceSwitcher", () => {
  it("scopes the sidebar to a new workspace, switches back, and follows an opened thread", async () => {
    using stack = new DisposableStack();
    // The dialog's layering comes from the app's stylesheet.
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const server = setup();
    await page.viewport(1280, 800);
    const router = createThreadRouter();
    // The test drives a router that has the thread route, not render()'s empty one.
    await using _screen = await render(<RouterProvider router={router} />, { router: false });

    await expect.element(sidebarProjects().getByText("alpha")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace…" }));
    await userEvent.fill(page.getByLabelText("Name"), "Client work");
    await userEvent.click(page.getByText("beta", { exact: true }).last());
    await userEvent.click(page.getByRole("button", { name: "Create workspace" }));

    // The new workspace is active and shows only its project; the server stored it.
    await expect.element(sidebarProjects().getByText("beta")).toBeVisible();
    await expect.element(sidebarProjects().getByText("alpha")).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(server.stored().map((entry) => entry.name)).toEqual(["Client work"]),
    );

    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "Personal" }));
    await expect.element(sidebarProjects().getByText("alpha")).toBeVisible();
    await expect.element(sidebarProjects().getByText("gamma")).toBeVisible();
    await expect.element(sidebarProjects().getByText("beta")).not.toBeInTheDocument();

    // Opening a thread of beta (from a link or the palette) switches to its workspace.
    const threadRef = scopeThreadRef(LOCAL, ThreadId.make("t1"));
    vi.mocked(useThreadShell).mockReturnValue({
      environmentId: LOCAL,
      id: threadRef.threadId,
      projectId: ProjectId.make("beta"),
    } as EnvironmentThreadShell);
    vi.mocked(useProject).mockReturnValue(projects[1]!);
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: "local", threadId: "t1" },
      }),
    );
    await expect.element(sidebarProjects().getByText("beta")).toBeVisible();
    await expect.element(sidebarProjects().getByText("alpha")).not.toBeInTheDocument();
  });
});

describe("loadEnvironmentWorkspaces", () => {
  const workspace: BanneretWorkspace = {
    id: "w1",
    name: "Client work",
    kind: "solo",
    projectKeys: [],
    updatedAt: "2026-11-26T10:00:00.000Z",
  };

  it("treats an environment that cannot answer as having no workspaces and never writes to it", async () => {
    setup();
    vi.mocked(workspacesRpc.list).mockResolvedValue(null);
    useWorkspacesStore.setState({ local: [workspace] });
    await loadEnvironmentWorkspaces(LOCAL);
    const state = useWorkspacesStore.getState();
    expect(state.byEnvironment[LOCAL]).toEqual([]);
    expect(state.supported.has(LOCAL)).toBe(false);
    expect(workspacesRpc.put).not.toHaveBeenCalled();
  });

  it("sends an environment that is behind the workspaces it lacks", async () => {
    const server = setup();
    useWorkspacesStore.setState({ local: [workspace] });
    await loadEnvironmentWorkspaces(LOCAL);
    expect(server.stored()).toEqual([workspace]);
    expect(useWorkspacesStore.getState().byEnvironment[LOCAL]).toEqual([workspace]);
  });
});
