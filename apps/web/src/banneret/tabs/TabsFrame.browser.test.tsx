// Banneret Hub: the open tabs bar in the real app (AppRoot with the app's router, against the
// in-process environment): it fits above every page, and its tabs follow and drive navigation.
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  BANNERET_WORKSPACES_WS_METHODS,
  type BanneretWorkspace,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { createMemoryHistory } from "@tanstack/react-router";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter, type AppRouter } from "~/router";
import {
  answerRpc,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  PROJECT_ID,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { loadEnvironmentWorkspaces, useWorkspacesStore } from "../workspacesStore";
import { TABS_STORAGE_KEY } from "./tabs.logic";
import { __reloadTabsForTests, setTabsHidden, useTabsStore } from "./tabsStore";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const workspace = (id: string, name: string): BanneretWorkspace => ({
  id,
  name,
  kind: "solo",
  projectKeys: [],
  updatedAt: "2026-11-26T10:00:00.000Z",
});
const ALPHA = workspace("ws-alpha", "Alpha");
const BETA = workspace("ws-beta", "Beta");

const THREAD = threadWithHistory("thread-tabs", 30);
const OTHER = threadWithHistory("thread-other", 2);
installFakeEnvironment([THREAD, OTHER]);
answerRpc(BANNERET_WORKSPACES_WS_METHODS.list, () => Effect.succeed({ workspaces: [ALPHA, BETA] }));
localStorage.removeItem(TABS_STORAGE_KEY);
__reloadTabsForTests();
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

async function mountApp(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await render(<AppRoot router={router} />, { container, router: false });
  return router;
}

const bar = () => document.querySelector<HTMLElement>("[data-banneret-tabs-bar]");
const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
const tabTitles = () => tabs().map((tab) => tab.textContent);
const activeTab = () => document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
const threadPath = (threadId: ThreadId) => `/${ENVIRONMENT_ID}/${threadId}`;

/** The page sits below the bar, ends at the window bottom, and nothing scrolls the document. */
function expectFits() {
  const shown = bar();
  expect(shown).not.toBeNull();
  const barBox = shown!.getBoundingClientRect();
  expect(barBox.height).toBeGreaterThan(20);
  expect(barBox.top).toBe(0);
  const insets = [...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-inset"]')];
  expect(insets.length).toBeGreaterThan(0);
  for (const inset of insets) {
    const box = inset.getBoundingClientRect();
    expect(box.top).toBe(barBox.bottom);
    expect(box.bottom).toBe(window.innerHeight);
  }
  const root = document.scrollingElement!;
  expect(root.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
  expect(root.scrollTop).toBe(0);
}

// One app for the whole file, as a user would browse it; each test starts where the last ended.
const router: AppRouter = await mountApp(threadPath(THREAD.id));

async function go(to: string) {
  await act(() => router.history.push(to));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(to));
}

describe("open tabs frame layout", () => {
  it("fits a chat thread; the timeline scrolls inside and header controls stay in the header", async () => {
    await expect.element(page.getByText(`Answer 29 for ${THREAD.id}.`)).toBeInTheDocument();
    await vi.waitFor(expectFits);
    const headerBox = document
      .querySelector<HTMLElement>("[data-chat-header]")!
      .getBoundingClientRect();
    expect(headerBox.top).toBe(bar()!.getBoundingClientRect().bottom);
    const scroller = [...document.querySelectorAll<HTMLElement>("[data-chat-column] *")].find(
      (element) =>
        element.scrollHeight > element.clientHeight + 50 &&
        ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
    );
    expect(scroller).toBeDefined();
    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-banneret-tabs-body] .fixed[class*="--workspace-controls-top"]',
    )) {
      const box = element.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(headerBox.top);
      expect(box.top).toBeLessThan(headerBox.bottom);
    }
  });

  it("fits a draft", async () => {
    const draftId = DraftId.make("draft-tabs");
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);
    await go(`/draft/${draftId}`);
    await vi.waitFor(expectFits);
  });

  it.each(["/today", "/board", "/map", "/feed", "/needs", "/pull-requests"])(
    "fits %s",
    async (path) => {
      await go(path);
      await vi.waitFor(expectFits);
    },
  );

  it("keeps the pull requests header controls level with its header", async () => {
    await go("/pull-requests");
    await vi.waitFor(expectFits);
    const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')!;
    const insetTop = inset.getBoundingClientRect().top;
    for (const element of inset.querySelectorAll<HTMLElement>(
      '.absolute[class*="--workspace-controls-top"]',
    )) {
      expect(element.getBoundingClientRect().top).toBe(insetTop);
    }
  });

  it("opens settings over the bar and the sidebar", async () => {
    await go("/settings/general");
    const modal = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-app-modal]")?.parentElement;
      expect(found).toBeDefined();
      return found!;
    });
    const box = modal.getBoundingClientRect();
    expect(box.top).toBe(0);
    expect(box.left).toBe(0);
    expect(box.bottom).toBe(window.innerHeight);
    expect(document.scrollingElement!.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
  });

  it("moves the toggle of a collapsed sidebar into the page header", async () => {
    await go(threadPath(THREAD.id));
    await vi.waitFor(expectFits);
    const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
    const control = document.querySelector<HTMLElement>("[data-sidebar-control]")!;
    await page.getByRole("button", { name: "Toggle main sidebar" }).click();
    await vi.waitFor(() => expect(wrapper.dataset.sidebarState).toBe("collapsed"));
    const header = document
      .querySelector<HTMLElement>("[data-chat-header]")!
      .getBoundingClientRect();
    await vi.waitFor(() => expect(control.getBoundingClientRect().top).toBe(header.top));
    expectFits();
    await page.getByRole("button", { name: "Toggle main sidebar" }).click();
    await vi.waitFor(() => expect(wrapper.dataset.sidebarState).toBe("expanded"));
  });

  it("lays the page out as upstream does below md", async () => {
    await page.viewport(700, 900);
    try {
      await vi.waitFor(() => {
        expect(getComputedStyle(bar()!).display).toBe("none");
        const frame = document.querySelector<HTMLElement>("[data-banneret-tabs-frame]")!;
        expect(getComputedStyle(frame).display).toBe("contents");
      });
    } finally {
      await page.viewport(1400, 900);
    }
  });
});

describe("open tabs", () => {
  it("reuses one italic preview tab while browsing", async () => {
    await go(threadPath(THREAD.id));
    await go(threadPath(OTHER.id));
    await vi.waitFor(() => {
      const previews = tabs().filter((tab) => tab.dataset.preview !== undefined);
      expect(previews).toHaveLength(1);
      expect(getComputedStyle(previews[0]!).fontStyle).toBe("italic");
      expect(activeTab()).toBe(previews[0]);
    });
  });

  it("keeps a preview tab on double-click, then opens a new preview beside it", async () => {
    await go(threadPath(THREAD.id));
    await vi.waitFor(() => expect(activeTab()?.dataset.preview).toBe(""));
    await userEvent.dblClick(activeTab()!);
    await vi.waitFor(() => expect(activeTab()?.dataset.preview).toBeUndefined());
    const count = tabs().length;
    await go(threadPath(OTHER.id));
    await vi.waitFor(() => {
      expect(tabs()).toHaveLength(count + 1);
      expect(activeTab()?.dataset.preview).toBe("");
    });
  });

  it("keeps a preview tab when it is pinned", async () => {
    await go("/map");
    await vi.waitFor(() => expect(activeTab()?.textContent).toContain("Map"));
    const preview = activeTab()!;
    expect(preview.dataset.preview).toBe("");
    await userEvent.hover(preview);
    await page.getByRole("button", { name: /^Pin Map/ }).click();
    await vi.waitFor(() => {
      expect(preview.dataset.pinned).toBe("");
      expect(preview.dataset.preview).toBeUndefined();
    });
  });

  it("activates a tab on click", async () => {
    const threadTab = tabs().find((tab) => tab.textContent?.includes(THREAD.title))!;
    await userEvent.click(threadTab);
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe(threadPath(THREAD.id));
      expect(activeTab()).toBe(threadTab);
    });
  });

  // Pointer events, not HTML5 drag events: the desktop bar is a window drag region, and on Windows
  // HTML5 drag events do not reach the page over one.
  it("reorders tabs by dragging with the pointer", async () => {
    await go(threadPath(OTHER.id));
    await vi.waitFor(() => expect(tabs().length).toBeGreaterThan(2));
    const [first, , third] = tabs();
    const firstId = first!.dataset.tabId;
    const from = first!.getBoundingClientRect();
    const to = third!.getBoundingClientRect();
    const at = (x: number) => ({ clientX: x, clientY: from.top + from.height / 2 });
    const pointer = (target: EventTarget, type: string, x: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          isPrimary: true,
          pointerId: 1,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          ...at(x),
        }),
      );
    const startX = from.left + from.width / 2;
    const endX = to.left + to.width / 2 + 2;
    await act(() => pointer(first!, "pointerdown", startX));
    for (let step = 1; step <= 10; step += 1) {
      await act(() => pointer(document, "pointermove", startX + ((endX - startX) * step) / 10));
    }
    await act(() => pointer(document, "pointerup", endX));
    // Dropped on the third tab from the left, it lands after it.
    await vi.waitFor(() => expect(tabs()[2]?.dataset.tabId).toBe(firstId));
  });

  it("keeps tabs and the menu out of the desktop window drag region, and empty bar space in it", async () => {
    const shown = bar()!;
    // The desktop app adds this class (isElectron); the browser test adds it by hand.
    shown.classList.add("drag-region");
    try {
      const region = (element: Element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region");
      expect(region(shown)).toBe("drag");
      // Empty bar space: the tab list adds no rectangle of its own, so the bar's drag shows through.
      const list = shown.querySelector('[role="tablist"]')!;
      expect(["", "initial", "none", "drag"]).toContain(region(list));
      expect(region(list)).not.toBe("no-drag");
      for (const tab of tabs()) expect(region(tab)).toBe("no-drag");
      expect(region(page.getByRole("button", { name: "Tabs bar options" }).element())).toBe(
        "no-drag",
      );
    } finally {
      shown.classList.remove("drag-region");
    }
  });

  it("closes a tab with its close button and the active one moves to a neighbour", async () => {
    const before = tabTitles();
    const active = activeTab()!;
    const index = tabs().indexOf(active);
    const neighbour = tabs()[index + 1] ?? tabs()[index - 1]!;
    await userEvent.hover(active);
    await page.getByRole("button", { name: `Close ${active.textContent}` }).click();
    await vi.waitFor(() => {
      expect(tabTitles()).toHaveLength(before.length - 1);
      expect(activeTab()?.dataset.tabId).toBe(neighbour.dataset.tabId);
    });
  });

  it("closes a tab on middle-click", async () => {
    await go(threadPath(OTHER.id));
    await vi.waitFor(() => expect(activeTab()?.textContent).toContain(OTHER.title));
    const count = tabs().length;
    const target = activeTab()!;
    target.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await vi.waitFor(() => expect(tabs()).toHaveLength(count - 1));
    expect(tabs().includes(target)).toBe(false);
  });

  it("switches the workspace when a page tab of another workspace is clicked", async () => {
    await vi.waitFor(() =>
      expect(useWorkspacesStore.getState().byEnvironment[ENVIRONMENT_ID]).toBeDefined(),
    );
    await act(() => useWorkspacesStore.setState({ activeId: ALPHA.id }));
    await go("/board");
    await vi.waitFor(() => expect(activeTab()?.textContent).toBe("Board · Alpha"));
    await userEvent.dblClick(activeTab()!);
    await act(() => useWorkspacesStore.setState({ activeId: BETA.id }));
    await go("/today");
    await vi.waitFor(() => expect(activeTab()?.textContent).toBe("Today · Beta"));
    const alphaBoard = tabs().find((tab) => tab.textContent === "Board · Alpha")!;
    await userEvent.click(alphaBoard);
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe("/board");
      expect(useWorkspacesStore.getState().activeId).toBe(ALPHA.id);
      expect(activeTab()).toBe(alphaBoard);
    });
    // The switch in between did not turn the Beta preview into "Today · Alpha".
    expect(tabTitles()).not.toContain("Today · Alpha");
    expect(useTabsStore.getState().tabs.filter((tab) => !tab.kept)).toHaveLength(1);
  });

  it("closes the inactive page tabs of a workspace deleted elsewhere", async () => {
    await vi.waitFor(() => expect(tabTitles()).toContain("Today · Beta"));
    await userEvent.dblClick(tabs().find((tab) => tab.textContent === "Today · Beta")!);
    await go(threadPath(THREAD.id));
    using _deleted = answerRpc(BANNERET_WORKSPACES_WS_METHODS.list, () =>
      Effect.succeed({ workspaces: [ALPHA] }),
    );
    await act(() => loadEnvironmentWorkspaces(ENVIRONMENT_ID));
    await vi.waitFor(() =>
      expect(tabTitles().some((title) => title?.includes("Beta"))).toBe(false),
    );
    expect(tabTitles()).toContain("Board · Alpha");
    await act(() => loadEnvironmentWorkspaces(ENVIRONMENT_ID));
  });

  it("stays on a page whose remembered workspace no longer exists", async () => {
    await act(() => useWorkspacesStore.setState({ activeId: "ws-gone" }));
    await go("/map");
    await vi.waitFor(() => expect(activeTab()?.textContent).toBe("Map"));
    expect(router.state.location.pathname).toBe("/map");
    await act(() => useWorkspacesStore.setState({ activeId: null }));
  });

  it("hides the bar without remounting the page, and shows it again", async () => {
    await go(threadPath(THREAD.id));
    await vi.waitFor(expectFits);
    const composer = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await userEvent.click(composer);
    await userEvent.keyboard("still here");
    await page.getByRole("button", { name: "Tabs bar options" }).click();
    await page.getByRole("menuitem", { name: "Hide tabs bar" }).click();
    await vi.waitFor(() => {
      expect(getComputedStyle(bar()!).display).toBe("none");
      const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')!;
      expect(inset.getBoundingClientRect().top).toBe(0);
    });
    expect(composer.isConnected).toBe(true);
    expect(composer.textContent).toContain("still here");
    await act(() => setTabsHidden(false));
    await vi.waitFor(expectFits);
  });
});
