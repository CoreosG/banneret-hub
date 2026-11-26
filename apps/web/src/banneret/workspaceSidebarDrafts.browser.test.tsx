import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BanneretWorkspace,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import Sidebar from "../components/Sidebar";
import { SidebarProvider } from "../components/ui/sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import type { Project } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { workspaceProjectKey, type ActiveWorkspaceId } from "./workspaces.logic";
import { useWorkspacesStore } from "./workspacesStore";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("../components/sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

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

const alpha = project("alpha");
const beta = project("beta");
const gamma = project("gamma");

const clientWork = (projects: ReadonlyArray<Project>): BanneretWorkspace => ({
  id: "client",
  name: "Client work",
  kind: "solo",
  projectKeys: projects.map(workspaceProjectKey),
  updatedAt: "2026-11-26T10:00:00.000Z",
});

function addDraft(inProject: Project, prompt: string) {
  const draftId = DraftId.make(`draft-${inProject.id}`);
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(LOCAL, inProject.id), draftId, {
    threadId: ThreadId.make(`draft-thread-${inProject.id}`),
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  store.setPrompt(draftId, prompt);
}

function setup(
  stack: DisposableStack,
  input: {
    readonly workspace: BanneretWorkspace;
    readonly activeId: ActiveWorkspaceId;
    readonly scope?: ReadonlyArray<Project>;
  },
) {
  const drafts = useComposerDraftStore.getState();
  const ui = useUiStateStore.getState();
  const previousSettings = getClientSettings();
  stack.defer(() => {
    useComposerDraftStore.setState(drafts, true);
    useUiStateStore.setState(ui, true);
    __setClientSettingsForTests(previousSettings);
  });
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  useWorkspacesStore.setState({
    byEnvironment: {},
    supported: new Set(),
    local: [input.workspace],
    activeId: input.activeId,
    dialog: null,
  });
  useUiStateStore.setState({
    sidebarProjectScopeKeys: (input.scope ?? []).map(derivePhysicalProjectKey),
  });
  vi.mocked(useProjects).mockReturnValue([alpha, beta, gamma]);
  vi.mocked(useQuietThreadShells).mockReturnValue([]);
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([LOCAL]);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(LOCAL);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn(),
    routeDraftId: null,
    routeThreadRef: null,
  });
}

const renderSidebar = () =>
  render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );

describe("sidebar drafts follow the active workspace", () => {
  it("hides a draft of another workspace's project from Personal and shows it in its workspace", async () => {
    using stack = new DisposableStack();
    setup(stack, { workspace: clientWork([beta]), activeId: null });
    addDraft(beta, "Beta draft prompt");
    addDraft(alpha, "Alpha draft prompt");
    await using screen = await renderSidebar();

    await expect.element(screen.getByText("Alpha draft prompt")).toBeVisible();
    await expect.element(screen.getByText("Beta draft prompt")).not.toBeInTheDocument();

    await act(() => useWorkspacesStore.setState({ activeId: "client" }));
    await expect.element(screen.getByText("Beta draft prompt")).toBeVisible();
    await expect.element(screen.getByText("Alpha draft prompt")).not.toBeInTheDocument();
  });

  it("keeps a picked project scope inside the workspace", async () => {
    using stack = new DisposableStack();
    setup(stack, { workspace: clientWork([beta, gamma]), activeId: "client", scope: [beta] });
    addDraft(beta, "Beta draft prompt");
    addDraft(gamma, "Gamma draft prompt");
    addDraft(alpha, "Alpha draft prompt");
    await using screen = await renderSidebar();

    await expect.element(screen.getByText("Beta draft prompt")).toBeVisible();
    await expect.element(screen.getByText("Gamma draft prompt")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Alpha draft prompt")).not.toBeInTheDocument();
  });

  it("drops a scope on another workspace's project back to the workspace's own drafts", async () => {
    using stack = new DisposableStack();
    setup(stack, { workspace: clientWork([beta]), activeId: "client", scope: [alpha] });
    addDraft(beta, "Beta draft prompt");
    addDraft(alpha, "Alpha draft prompt");
    await using screen = await renderSidebar();

    await expect.element(screen.getByText("Beta draft prompt")).toBeVisible();
    await expect.element(screen.getByText("Alpha draft prompt")).not.toBeInTheDocument();
  });

  it("names the workspace when its projects have neither threads nor drafts", async () => {
    using stack = new DisposableStack();
    setup(stack, { workspace: clientWork([beta]), activeId: "client" });
    // A draft elsewhere must not hide the empty line.
    addDraft(alpha, "Alpha draft prompt");
    await using screen = await renderSidebar();

    await expect.element(screen.getByText("No threads in Client work yet")).toBeVisible();
    await expect.element(screen.getByText("Alpha draft prompt")).not.toBeInTheDocument();
  });
});
