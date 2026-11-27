import { describe, expect, it } from "vite-plus/test";

import {
  closeTabs,
  EMPTY_TABS,
  keepTab,
  MAX_TABS,
  moveTab,
  observeTarget,
  parseTabsState,
  tabKey,
  togglePin,
  type TabsState,
  type TabTarget,
} from "./tabs.logic";

const thread = (id: string, environmentId = "env-a"): TabTarget => ({
  kind: "thread",
  href: `/${environmentId}/${id}`,
  threadRef: { environmentId, threadId: id },
  title: id,
  draft: false,
});

const page = (href: string, workspaceId: string | null): TabTarget => ({
  kind: "page",
  href,
  workspaceId,
  title: href,
});

function ids() {
  let next = 0;
  return () => `tab-${++next}`;
}

function visit(state: TabsState, targets: ReadonlyArray<TabTarget>, newId = ids(), start = 1) {
  let current = state;
  targets.forEach((target, index) => {
    current = observeTarget(current, target, start + index, newId);
  });
  return current;
}

describe("observeTarget", () => {
  it("keeps one tab per page while its filters change, and remembers the latest filters", () => {
    const state = visit(EMPTY_TABS, [
      page("/board", "w1"),
      page("/board?board=ops&q=deploy", "w1"),
    ]);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.href).toBe("/board?board=ops&q=deploy");
    expect(tabKey(state.tabs[0]!)).toBe("page:w1:/board");
  });

  it("reuses one preview tab while browsing", () => {
    const state = visit(EMPTY_TABS, [thread("a"), thread("b"), page("/map", "w1")]);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ href: "/map", kept: false, workspaceId: "w1" });
    expect(state.activeId).toBe(state.tabs[0]!.id);
  });

  it("opens a new preview after the preview is kept, and activates open tabs", () => {
    const newId = ids();
    let state = visit(EMPTY_TABS, [thread("a")], newId);
    state = keepTab(state, state.tabs[0]!.id);
    state = observeTarget(state, thread("b"), 2, newId);
    expect(state.tabs.map((tab) => [tab.title, tab.kept])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    state = observeTarget(state, thread("a"), 3, newId);
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe(state.tabs[0]!.id);
    expect(state.tabs[0]!.lastActiveAt).toBe(3);
  });

  it("dedupes threads by environment and thread, pages by workspace and path", () => {
    const newId = ids();
    let state = EMPTY_TABS;
    for (const target of [
      thread("a", "env-a"),
      thread("a", "env-b"),
      page("/map", "w1"),
      page("/map", "w2"),
      page("/map", null),
    ]) {
      state = observeTarget(state, target, 1, newId);
      state = keepTab(state, state.activeId!);
    }
    expect(state.tabs).toHaveLength(5);
    state = observeTarget(state, page("/map", "w2"), 2, newId);
    expect(state.tabs).toHaveLength(5);
    expect(tabKey(state.tabs.find((tab) => tab.id === state.activeId)!)).toBe("page:w2:/map");
  });

  it("clears the active tab on a route no tab holds", () => {
    const state = visit(EMPTY_TABS, [thread("a")]);
    const after = observeTarget(state, null, 2, ids());
    expect(after.activeId).toBeNull();
    expect(after.tabs).toHaveLength(1);
  });

  it("follows a sent draft to its server route and keeps the tab", () => {
    const newId = ids();
    const draft: TabTarget = {
      kind: "thread",
      href: "/draft/d1",
      threadRef: { environmentId: "env-a", threadId: "t1" },
      title: "New thread",
      draft: true,
    };
    let state = observeTarget(EMPTY_TABS, draft, 1, newId);
    state = observeTarget(state, thread("t1"), 2, newId);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ href: "/env-a/t1", kept: true });
  });

  it("re-keys a draft tab sent as a thread with a new id", () => {
    const newId = ids();
    const draft: TabTarget = {
      kind: "thread",
      href: "/draft/d1",
      threadRef: null,
      title: "New thread",
      draft: true,
    };
    let state = observeTarget(EMPTY_TABS, draft, 1, newId);
    state = keepTab(state, state.tabs[0]!.id);
    state = observeTarget(
      state,
      { ...thread("t9"), promotedFrom: "href:/draft/d1" } as TabTarget,
      2,
      newId,
    );
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      href: "/env-a/t9",
      threadRef: { environmentId: "env-a", threadId: "t9" },
      kept: true,
    });
  });
});

describe("kept and pinned", () => {
  it("pinning keeps a tab; unpinning leaves it kept", () => {
    let state = visit(EMPTY_TABS, [thread("a")]);
    const id = state.tabs[0]!.id;
    state = togglePin(state, id);
    expect(state.tabs[0]).toMatchObject({ pinned: true, kept: true });
    state = togglePin(state, id);
    expect(state.tabs[0]).toMatchObject({ pinned: false, kept: true });
  });
});

describe("eviction", () => {
  it("closes the least recently used unpinned tab past the limit, never the active one", () => {
    const newId = ids();
    let state = EMPTY_TABS;
    for (let index = 0; index < MAX_TABS; index++) {
      state = observeTarget(state, thread(`t${index}`), 10 + index, newId);
      state = keepTab(state, state.activeId!);
    }
    // t0 is the oldest; pinning it moves eviction to t1.
    state = togglePin(state, state.tabs[0]!.id);
    state = observeTarget(state, thread("new"), 100, newId);
    expect(state.tabs).toHaveLength(MAX_TABS);
    expect(state.tabs.map((tab) => tab.title)).not.toContain("t1");
    expect(state.tabs.map((tab) => tab.title)).toContain("t0");
    expect(state.tabs.find((tab) => tab.id === state.activeId)?.title).toBe("new");
  });

  it("gives a new target no tab when every slot is pinned", () => {
    const newId = ids();
    let state = EMPTY_TABS;
    for (let index = 0; index < MAX_TABS; index++) {
      state = observeTarget(state, thread(`t${index}`), index, newId);
      state = togglePin(state, state.activeId!);
    }
    state = observeTarget(state, thread("new"), 100, newId);
    expect(state.tabs).toHaveLength(MAX_TABS);
    expect(state.activeId).toBeNull();
  });
});

describe("closeTabs and moveTab", () => {
  const three = () => {
    const newId = ids();
    let state = EMPTY_TABS;
    for (const name of ["a", "b", "c"]) {
      state = observeTarget(state, thread(name), 1, newId);
      state = keepTab(state, state.activeId!);
    }
    return state;
  };

  it("activates the right neighbour, then the left, then nothing", () => {
    let state = three();
    const [a, b, c] = state.tabs;
    state = { ...state, activeId: b!.id };
    let closed = closeTabs(state, new Set([b!.id]));
    expect(closed.next?.id).toBe(c!.id);
    closed = closeTabs({ ...closed.state, activeId: c!.id }, new Set([c!.id]));
    expect(closed.next?.id).toBe(a!.id);
    closed = closeTabs(closed.state, new Set([a!.id]));
    expect(closed).toMatchObject({ closedActive: true, next: null });
    expect(closed.state.tabs).toHaveLength(0);
  });

  it("closing an inactive tab leaves the active one", () => {
    const state = three();
    const closed = closeTabs(state, new Set([state.tabs[0]!.id]));
    expect(closed.closedActive).toBe(false);
    expect(closed.state.activeId).toBe(state.activeId);
  });

  it("moves a tab before another or to the end", () => {
    let state = three();
    const [a, b, c] = state.tabs;
    state = moveTab(state, c!.id, a!.id);
    expect(state.tabs.map((tab) => tab.title)).toEqual(["c", "a", "b"]);
    state = moveTab(state, c!.id, null);
    expect(state.tabs.map((tab) => tab.id)).toEqual([a!.id, b!.id, c!.id]);
  });
});

describe("parseTabsState", () => {
  it("round-trips what the store saves", () => {
    const state = { ...visit(EMPTY_TABS, [thread("a"), page("/map", "w1")]), hidden: true };
    expect(parseTabsState(JSON.stringify(state))).toEqual(state);
  });

  it("rejects other shapes, so the store wipes them", () => {
    expect(parseTabsState(null)).toBeNull();
    expect(parseTabsState("not json")).toBeNull();
    expect(parseTabsState(JSON.stringify({ tabs: [], activeId: null }))).toBeNull();
    const state = visit(EMPTY_TABS, [thread("a")]);
    const old = { ...state, hidden: false, tabs: state.tabs.map(({ kept: _, ...tab }) => tab) };
    expect(parseTabsState(JSON.stringify(old))).toBeNull();
    const twoPreviews = {
      ...state,
      hidden: false,
      tabs: [state.tabs[0], { ...state.tabs[0]!, id: "other", href: "/env-a/b" }],
    };
    expect(parseTabsState(JSON.stringify(twoPreviews))).toBeNull();
  });
});
