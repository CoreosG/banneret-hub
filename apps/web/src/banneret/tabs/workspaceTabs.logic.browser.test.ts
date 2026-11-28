// Banneret Hub: the Workspaces tabs model and what it saves.
import { describe, expect, it } from "vite-plus/test";

import { TABS_STORAGE_KEY } from "./tabs.logic";
import { __reloadTabsForTests, useTabsStore } from "./tabsStore";
import {
  EMPTY_WORKSPACE_TABS,
  forgetLastChat,
  hideWorkspaces,
  moveWorkspace,
  openTabs,
  parseWorkspaceTabs,
  seedWorkspaces,
  shownWorkspace,
  toggleWorkspacePin,
  visitWorkspace,
  WORKSPACE_TABS_STORAGE_KEY,
  type WorkspaceChat,
  type WorkspaceIdentity,
  type WorkspaceTabsState,
} from "./workspaceTabs.logic";
import {
  __reloadWorkspaceTabsForTests,
  hide,
  pinWorkspace,
  setSavedTabsMode,
  useWorkspaceTabsStore,
  visit,
} from "./workspaceTabsStore";

const ws = (key: string, ...members: string[]): WorkspaceIdentity => ({
  key,
  members: members.length > 0 ? members : [`env:/${key}`],
});
const A = ws("a");
const B = ws("b");
const C = ws("c");
const ALL = [A, B, C];
const chat = (id: string): WorkspaceChat => ({
  href: `/env/${id}`,
  threadRef: { environmentId: "env", threadId: id },
});

const visited = (...workspaces: WorkspaceIdentity[]) =>
  workspaces.reduce<WorkspaceTabsState>(
    (state, workspace, index) =>
      visitWorkspace(state, workspace, chat(`${workspace.key}-1`), index + 1),
    EMPTY_WORKSPACE_TABS,
  );
const keys = (state: WorkspaceTabsState, listed = ALL) =>
  openTabs(state, listed).map((tab) => tab.entry.key);
const entry = (state: WorkspaceTabsState, key: string) =>
  state.entries.find((candidate) => candidate.key === key)!;
const all = () => true;

describe("one tab per workspace", () => {
  it("opens a tab on the first visit and reuses it, remembering each last chat", () => {
    let state = visited(A, B);
    state = visitWorkspace(state, A, chat("a-2"), 3);
    expect(keys(state)).toEqual(["a", "b"]);
    expect(state.activeKey).toBe("a");
    expect(entry(state, "a").lastChat).toEqual(chat("a-2"));
    expect(entry(state, "b").lastChat).toEqual(chat("b-1"));
  });

  it("keeps the last chat when a workspace is picked without one", () => {
    const state = visitWorkspace(visited(A, B), A, null, 3);
    expect(entry(state, "a").lastChat).toEqual(chat("a-1"));
    expect(state.activeKey).toBe("a");
  });

  it("leaves a chat that moved project as the last chat of its new workspace only", () => {
    const state = visitWorkspace(visited(A, B), B, chat("a-1"), 3);
    expect(entry(state, "a").lastChat).toBeNull();
    expect(entry(state, "b").lastChat).toEqual(chat("a-1"));
  });

  it("follows a project whose group key changes, and folds merged groups into one tab", () => {
    const state = visited(ws("path-a", "env:/a"), ws("path-b", "env:/b"));
    const renamed = ws("repo-a", "env:/a");
    expect(openTabs(state, [renamed]).map((tab) => tab.workspace.key)).toEqual(["repo-a"]);
    const merged = ws("repo", "env:/a", "env:/b");
    expect(openTabs(state, [merged]).map((tab) => tab.workspace.key)).toEqual(["repo"]);
    const after = visitWorkspace(state, merged, null, 3);
    expect(after.entries.map((e) => e.key)).toEqual(["repo"]);
    expect(after.activeKey).toBe("repo");
  });

  it("closes and pins as one the two saved tabs of projects grouped since", () => {
    // The same repository on two machines, saved by path before the repository was known.
    const merged = ws("repo", "pc:/repo", "wsl:/repo");
    useWorkspaceTabsStore.setState(
      visited(ws("pc-path", "pc:/repo"), ws("wsl-path", "wsl:/repo"), C),
      true,
    );
    const listed = [merged, C];
    useWorkspaceTabsStore.setState((state) => ({
      ...state,
      entries: state.entries.map((e) => (e.key === "wsl-path" ? { ...e, pinned: true } : e)),
      activeKey: "wsl-path",
    }));
    const drawn = openTabs(useWorkspaceTabsStore.getState(), listed);
    expect(drawn.map((tab) => [tab.entry.key, tab.entry.pinned, tab.entry.lastChat])).toEqual([
      ["pc-path", true, chat("wsl-path-1")],
      ["c", false, chat("c-1")],
    ]);
    expect(shownWorkspace(useWorkspaceTabsStore.getState(), listed, all)?.key).toBe("repo");
    pinWorkspace("pc-path", listed);
    expect(openTabs(useWorkspaceTabsStore.getState(), listed)[0]!.entry.pinned).toBe(false);
    hide(new Set(["pc-path"]), ["pc-path", "c"], "pc-path", listed);
    expect(keys(useWorkspaceTabsStore.getState(), listed)).toEqual(["c"]);
    expect(useWorkspaceTabsStore.getState().activeKey).toBe("c");
    localStorage.removeItem(WORKSPACE_TABS_STORAGE_KEY);
    __reloadWorkspaceTabsForTests();
  });

  it("keeps the saved tab of a workspace that is not listed right now", () => {
    const state = visited(A, B);
    expect(keys(state, [A])).toEqual(["a"]);
    expect(keys(visitWorkspace(state, A, null, 3), [A, B])).toEqual(["a", "b"]);
  });
});

describe("close, pin and reorder", () => {
  it("hides a closed tab, keeps its last chat, and reopens it at the end", () => {
    const start = toggleWorkspacePin(visited(A, B, C), "a");
    const { state } = hideWorkspaces(start, new Set(["a"]), ["a", "b", "c"], "c");
    expect(keys(state)).toEqual(["b", "c"]);
    expect(entry(state, "a")).toMatchObject({ open: false, pinned: false, lastChat: chat("a-1") });
    const back = visitWorkspace(state, A, null, 9);
    expect(keys(back)).toEqual(["b", "c", "a"]);
    expect(entry(back, "a").lastChat).toEqual(chat("a-1"));
  });

  it("moves a closed selected tab to the right neighbour, then the left, then nothing", () => {
    const state = visited(A, B, C);
    const drawn = ["a", "b", "c"];
    expect(hideWorkspaces(state, new Set(["b"]), drawn, "b")).toMatchObject({
      closedShown: true,
      next: "c",
    });
    expect(hideWorkspaces(state, new Set(["c"]), drawn, "c").next).toBe("b");
    const last = hideWorkspaces(state, new Set(drawn), drawn, "c");
    expect(last.next).toBeNull();
    expect(last.state.activeKey).toBeNull();
    expect(shownWorkspace(last.state, ALL, all)).toBeNull();
  });

  it("leaves the selection alone when another tab closes", () => {
    const result = hideWorkspaces(visited(A, B, C), new Set(["a"]), ["a", "b", "c"], "c");
    expect(result.closedShown).toBe(false);
    expect(result.state.activeKey).toBe("c");
  });

  it("reorders tabs", () => {
    const state = visited(A, B, C);
    expect(keys(moveWorkspace(state, "c", "a"))).toEqual(["c", "a", "b"]);
    expect(keys(moveWorkspace(state, "a", null))).toEqual(["b", "c", "a"]);
  });

  it("forgets only a deleted last chat", () => {
    const state = forgetLastChat(visited(A, B), chat("a-1").href);
    expect(entry(state, "a")).toMatchObject({ open: true, lastChat: null });
    expect(entry(state, "b").lastChat).toEqual(chat("b-1"));
  });
});

describe("the shown workspace", () => {
  it("is the active one, or the latest open tab the workspace switcher shows", () => {
    const state = visitWorkspace(visited(A, B, C), A, null, 9);
    expect(shownWorkspace(state, ALL, all)?.key).toBe("a");
    expect(shownWorkspace(state, ALL, (w) => w.key !== "a")?.key).toBe("c");
    expect(shownWorkspace(state, ALL, () => false)).toBeNull();
  });

  it("is nothing before any tab opens, so the sidebar lists everything", () => {
    expect(shownWorkspace(EMPTY_WORKSPACE_TABS, ALL, all)).toBeNull();
  });
});

describe("switching to workspaces", () => {
  it("gives each open chat's workspace a tab with its latest chat", () => {
    const state = seedWorkspaces(EMPTY_WORKSPACE_TABS, [
      { workspace: B, chat: chat("b-old"), at: 1 },
      { workspace: A, chat: chat("a-1"), at: 2 },
      { workspace: B, chat: chat("b-new"), at: 3 },
    ]);
    expect(keys(state)).toEqual(["b", "a"]);
    expect(entry(state, "b").lastChat).toEqual(chat("b-new"));
  });

  it("keeps closed tabs closed and a newer last chat in place", () => {
    const start = hideWorkspaces(visited(A, B), new Set(["a"]), ["a", "b"], "b").state;
    const state = seedWorkspaces(start, [
      { workspace: A, chat: chat("a-later"), at: 10 },
      { workspace: B, chat: chat("b-earlier"), at: 0 },
    ]);
    expect(keys(state)).toEqual(["b"]);
    expect(entry(state, "a").lastChat).toEqual(chat("a-later"));
    expect(entry(state, "b").lastChat).toEqual(chat("b-1"));
  });
});

describe("what is saved on this device", () => {
  // Exactly what the previous release wrote: chats tabs, and nothing about "Tabs show".
  const PREVIOUS_RELEASE_TABS = JSON.stringify({
    tabs: [
      {
        id: "tab-1",
        kind: "thread",
        href: "/env/one",
        workspaceId: null,
        threadRef: { environmentId: "env", threadId: "one" },
        title: "One",
        pinned: true,
        kept: true,
        lastActiveAt: 5,
      },
      {
        id: "tab-2",
        kind: "page",
        href: "/board",
        workspaceId: null,
        threadRef: null,
        title: "Board",
        pinned: false,
        kept: false,
        lastActiveAt: 6,
      },
    ],
    activeId: "tab-2",
    hidden: false,
  });

  it("loads the previous release's state as Chats, with every tab", () => {
    localStorage.removeItem(WORKSPACE_TABS_STORAGE_KEY);
    localStorage.setItem(TABS_STORAGE_KEY, PREVIOUS_RELEASE_TABS);
    __reloadTabsForTests();
    __reloadWorkspaceTabsForTests();
    expect(useWorkspaceTabsStore.getState()).toEqual(EMPTY_WORKSPACE_TABS);
    expect(useWorkspaceTabsStore.getState().mode).toBe("chats");
    const { tabs, activeId, hidden } = useTabsStore.getState();
    expect({ tabs, activeId, hidden }).toEqual(JSON.parse(PREVIOUS_RELEASE_TABS));
    expect(localStorage.getItem(TABS_STORAGE_KEY)).toBe(PREVIOUS_RELEASE_TABS);
    localStorage.removeItem(TABS_STORAGE_KEY);
    __reloadTabsForTests();
  });

  it("restores the setting and each workspace's last chat after a reload", () => {
    localStorage.removeItem(WORKSPACE_TABS_STORAGE_KEY);
    __reloadWorkspaceTabsForTests();
    setSavedTabsMode("workspaces");
    visit(A, chat("a-1"));
    visit(B, chat("b-1"));
    pinWorkspace("a", ALL);
    const before = useWorkspaceTabsStore.getState();
    useWorkspaceTabsStore.setState(EMPTY_WORKSPACE_TABS, true);
    __reloadWorkspaceTabsForTests();
    expect(useWorkspaceTabsStore.getState()).toEqual(before);
    localStorage.removeItem(WORKSPACE_TABS_STORAGE_KEY);
    __reloadWorkspaceTabsForTests();
  });

  it.each([
    "{}",
    "not json",
    JSON.stringify({ mode: "grid", activeKey: null, entries: [] }),
    JSON.stringify({
      mode: "chats",
      activeKey: null,
      entries: [{ key: "a", members: [], open: false, pinned: true, visitedAt: 1, lastChat: null }],
    }),
  ])("wipes a saved copy it did not write: %s", (raw) => {
    expect(parseWorkspaceTabs(raw)).toBeNull();
    localStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, raw);
    __reloadWorkspaceTabsForTests();
    expect(useWorkspaceTabsStore.getState()).toEqual(EMPTY_WORKSPACE_TABS);
    expect(localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY)).toBeNull();
  });
});
