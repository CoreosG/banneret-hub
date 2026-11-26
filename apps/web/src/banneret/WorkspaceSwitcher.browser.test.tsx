import appCss from "../index.css?inline";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
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
import { COMPOSER_DRAFT_STORAGE_KEY, DraftId, useComposerDraftStore } from "../composerDraftStore";
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
import { WorkspaceNoThreads } from "./WorkspaceNoThreads";
import { WorkspacesHost } from "./WorkspacesHost";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { workspaceProjectKey } from "./workspaces.logic";
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
  vi.mocked(useProject).mockImplementation(
    (ref) => projects.find((candidate) => candidate.id === ref?.projectId) ?? null,
  );
  return { stored: () => stored };
}

function SidebarHarness() {
  const groups = useSidebarProjectGroups();
  return (
    <>
      <WorkspaceSwitcher homeLabel="T3 Code home" onBackdrop={false}>
        <span>Brand</span>
      </WorkspaceSwitcher>
      <ul aria-label="Sidebar projects">
        {groups.map((group) => (
          <li key={group.projectKey}>{group.displayName}</li>
        ))}
      </ul>
      <p aria-label="Empty sidebar">
        <WorkspaceNoThreads fallback="No threads yet" />
      </p>
      <WorkspacesHost />
    </>
  );
}

// The thread route the app uses, so opening a thread changes the router's params as it does there.
function createThreadRouter() {
  const root = createRootRoute({ component: SidebarHarness });
  const thread = createRoute({ getParentRoute: () => root, path: "/$environmentId/$threadId" });
  const draft = createRoute({ getParentRoute: () => root, path: "/draft/$draftId" });
  return createRouter({
    routeTree: root.addChildren([thread, draft]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    disableGlobalCatchBoundary: true,
  });
}

const sidebarProjects = () => page.getByRole("list", { name: "Sidebar projects" });

// The switcher's radio items; the check is aria-hidden, so it is found by its slot.
function checkedWorkspaces() {
  return [...document.querySelectorAll('[role="menuitemradio"]')].flatMap((item) =>
    item.querySelector('[data-slot="menu-radio-item-indicator"]') === null
      ? []
      : [item.textContent],
  );
}

// The switcher only shows from the md breakpoint up, and the dialog's layering comes from the app's
// stylesheet.
async function prepareScreen(stack: DisposableStack) {
  await page.viewport(1280, 800);
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
}

const clientWork = (projectKeys: string[]): BanneretWorkspace => ({
  id: "client",
  name: "Client work",
  kind: "solo",
  projectKeys,
  updatedAt: "2026-11-26T10:00:00.000Z",
});

describe("WorkspaceSwitcher", () => {
  it("scopes the sidebar to a new workspace, switches back, and follows an opened thread", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    const server = setup();
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
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: "local", threadId: "t1" },
      }),
    );
    await expect.element(sidebarProjects().getByText("beta")).toBeVisible();
    await expect.element(sidebarProjects().getByText("alpha")).not.toBeInTheDocument();
  });

  it("switches to the workspace of a draft opened in one of its projects", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    setup();
    const drafts = useComposerDraftStore.getState();
    stack.defer(() => {
      useComposerDraftStore.setState(drafts, true);
      localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    });
    // Personal is active; beta belongs to Client work.
    useWorkspacesStore.setState({ local: [clientWork([workspaceProjectKey(projects[1]!)])] });
    const router = createThreadRouter();
    await using _screen = await render(<RouterProvider router={router} />, { router: false });
    await expect.element(sidebarProjects().getByText("alpha")).toBeVisible();
    await expect.element(sidebarProjects().getByText("beta")).not.toBeInTheDocument();

    // "New thread in beta" (palette, sidebar or keybinding) opens a draft route for beta.
    const draftId = DraftId.make("draft-beta");
    drafts.setLogicalProjectDraftThreadId(
      "beta",
      scopeProjectRef(LOCAL, projects[1]!.id),
      draftId,
      {
        threadId: ThreadId.make("draft-thread"),
      },
    );
    await act(() => router.navigate({ to: "/draft/$draftId", params: { draftId } }));

    await expect.element(sidebarProjects().getByText("beta")).toBeVisible();
    await expect.element(sidebarProjects().getByText("alpha")).not.toBeInTheDocument();
    expect(useWorkspacesStore.getState().activeId).toBe("client");
  });

  it("checks the active workspace in the menu", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    setup();
    useWorkspacesStore.setState({ local: [clientWork([])] });
    const router = createThreadRouter();
    await using _screen = await render(<RouterProvider router={router} />, { router: false });

    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await expect.element(page.getByRole("menuitemradio", { name: "Client work" })).toBeVisible();
    expect(checkedWorkspaces()).toEqual(["Personal"]);

    await userEvent.click(page.getByRole("menuitemradio", { name: "Client work" }));
    // Picking closes the menu; reopen it once it has gone.
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Switch workspace" }));
    await expect
      .element(page.getByRole("menuitemradio", { name: "Client work" }))
      .toHaveAttribute("aria-checked", "true");
    await vi.waitFor(() => expect(checkedWorkspaces()).toEqual(["Client work"]));
  });

  it("names the active workspace when the sidebar has no threads", async () => {
    using stack = new DisposableStack();
    await prepareScreen(stack);
    setup();
    useWorkspacesStore.setState({ local: [clientWork([])] });
    const router = createThreadRouter();
    await using _screen = await render(<RouterProvider router={router} />, { router: false });
    const empty = page.getByLabelText("Empty sidebar");

    await expect.element(empty).toHaveTextContent("No threads yet");
    await act(() => useWorkspacesStore.setState({ activeId: "client" }));
    await expect.element(empty).toHaveTextContent("No threads in Client work yet");
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
