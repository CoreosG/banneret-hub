import { describe, expect, it } from "vite-plus/test";

import { TABS_STORAGE_KEY, type TabTarget } from "./tabs.logic";
import {
  __reloadTabsForTests,
  beginActivation,
  endActivation,
  keep,
  observeRoute,
  useTabsStore,
} from "./tabsStore";

const page = (href: "/map" | "/today", workspaceId: string | null): TabTarget => ({
  kind: "page",
  href,
  workspaceId,
  title: href,
});

function fresh(saved: string | null): Disposable {
  if (saved === null) localStorage.removeItem(TABS_STORAGE_KEY);
  else localStorage.setItem(TABS_STORAGE_KEY, saved);
  __reloadTabsForTests();
  return {
    [Symbol.dispose]: () => {
      localStorage.removeItem(TABS_STORAGE_KEY);
      __reloadTabsForTests();
    },
  };
}

describe("tabs store", () => {
  it("saves every change and loads it back", () => {
    using _store = fresh(null);
    observeRoute(page("/map", "w1"));
    keep(useTabsStore.getState().activeId!);
    observeRoute(page("/today", "w1"));
    const saved = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY)!);
    expect(saved.tabs).toHaveLength(2);
    __reloadTabsForTests();
    const { tabs, activeId } = useTabsStore.getState();
    expect(tabs.map((tab) => [tab.href, tab.kept])).toEqual([
      ["/map", true],
      ["/today", false],
    ]);
    expect(activeId).toBe(tabs[1]!.id);
  });

  it("wipes a saved copy of another shape", () => {
    using _store = fresh(JSON.stringify({ tabs: [{ id: "x", href: "/map" }], activeId: "x" }));
    expect(useTabsStore.getState().tabs).toEqual([]);
    expect(localStorage.getItem(TABS_STORAGE_KEY)).toBeNull();
  });

  it("ignores the route while a page tab is being activated, until it shows", () => {
    using _store = fresh(null);
    observeRoute(page("/map", "w1"));
    keep(useTabsStore.getState().activeId!);
    observeRoute(page("/today", "w2"));
    const map = useTabsStore.getState().tabs[0]!;
    beginActivation(map);
    // The workspace switched first; the router still shows /today.
    observeRoute(page("/today", "w1"));
    expect(useTabsStore.getState().tabs.map((tab) => tab.workspaceId)).toEqual(["w1", "w2"]);
    observeRoute(page("/map", "w1"));
    expect(useTabsStore.getState()).toMatchObject({ activating: null, activeId: map.id });
  });

  it("follows the router again once an activation ends without showing its tab", () => {
    using _store = fresh(null);
    observeRoute(page("/map", "w1"));
    beginActivation(useTabsStore.getState().tabs[0]!);
    endActivation();
    observeRoute(page("/today", "w1"));
    expect(useTabsStore.getState().tabs.map((tab) => tab.href)).toEqual(["/today"]);
  });
});
