import { EnvironmentId, ProjectId, ThreadId, type BanneretWorkspace } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { CommandPalette } from "../components/CommandPalette";
import { LAST_USED_PROJECT_STORAGE_KEY } from "../hooks/useHandleNewThread";
import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { workspaceProjectKey, type ActiveWorkspaceId } from "./workspaces.logic";
import { useWorkspacesStore } from "./workspacesStore";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => entities.projects,
  useVisibleThreadShells: () => entities.threads,
  useDelegatedUnderParent: () => new Set<string>(),
}));

const LOCAL = EnvironmentId.make("local");

function project(title: string): Project {
  return {
    id: ProjectId.make(title),
    environmentId: LOCAL,
    title,
    workspaceRoot: `/work/${title}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    scripts: [],
  };
}

const alpha = project("alpha");
const beta = project("beta");
const gamma = project("gamma");

function thread(title: string, inProject: Project): Thread {
  return makeThreadFixture({
    environmentId: LOCAL,
    id: ThreadId.make(title),
    projectId: inProject.id,
    title,
  });
}

const work: BanneretWorkspace = {
  id: "work",
  name: "Work",
  kind: "solo",
  projectKeys: [workspaceProjectKey(alpha)],
  updatedAt: "2026-03-01T00:00:00.000Z",
};

/** "Work" holds alpha; beta and gamma stay in Personal. */
function setup(activeId: ActiveWorkspaceId) {
  removeLocalStorageItem(LAST_USED_PROJECT_STORAGE_KEY);
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  useWorkspacesStore.setState({
    byEnvironment: {},
    supported: new Set(),
    local: [work],
    activeId,
    dialog: null,
  });
  entities.projects = [alpha, beta, gamma];
  entities.threads = [
    thread("Alpha fix login", alpha),
    thread("Beta fix login", beta),
    thread("Gamma fix login", gamma),
  ];
}

const option = (name: RegExp) => page.getByRole("option", { name });

describe("command palette threads follow the active workspace", () => {
  it("searches only the active workspace's threads until widened to the others", async () => {
    setup("work");
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette({ query: "fix login" });

    await expect.element(option(/Alpha fix login/)).toBeVisible();
    await expect.element(option(/Beta fix login/)).not.toBeInTheDocument();
    await expect.element(option(/Gamma fix login/)).not.toBeInTheDocument();
    const widen = option(/^Show 2 results in other workspaces$/);
    await expect.element(widen).toBeVisible();

    await widen.click();
    await expect.element(option(/Beta fix login/)).toBeVisible();
    await expect.element(option(/Gamma fix login/)).toBeVisible();
    await expect.element(option(/Alpha fix login/)).toBeVisible();
    await expect.element(option(/in other workspaces/)).not.toBeInTheDocument();
    expect(useCommandPaletteStore.getState().open).toBe(true);

    await userEvent.clear(page.getByPlaceholder("Search commands, projects, and threads..."));
    await expect.element(option(/Alpha fix login/)).toBeVisible();
    await expect.element(option(/Beta fix login/)).not.toBeInTheDocument();
  });

  it("lists only the active workspace's recent threads, without the widen row", async () => {
    setup("work");
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette();

    await expect.element(option(/Alpha fix login/)).toBeVisible();
    await expect.element(option(/Beta fix login/)).not.toBeInTheDocument();
    await expect.element(option(/in other workspaces/)).not.toBeInTheDocument();
  });

  it("leaves projects assigned to another workspace out of Personal", async () => {
    setup(null);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette({ query: "fix login" });

    await expect.element(option(/Beta fix login/)).toBeVisible();
    await expect.element(option(/Gamma fix login/)).toBeVisible();
    await expect.element(option(/Alpha fix login/)).not.toBeInTheDocument();
    await option(/^Show 1 result in other workspaces$/).click();
    await expect.element(option(/Alpha fix login/)).toBeVisible();
  });

  it("offers no widen row when nothing outside the workspace matches", async () => {
    setup("work");
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette({ query: "alpha" });

    await expect.element(option(/Alpha fix login/)).toBeVisible();
    await expect.element(option(/in other workspaces/)).not.toBeInTheDocument();
  });
});
