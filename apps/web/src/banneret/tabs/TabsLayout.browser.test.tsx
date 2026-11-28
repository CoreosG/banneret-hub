// Banneret Hub: the tabs bar in the real app. A tab can always be closed, tabs have a context menu,
// and the thread's Tool access panel closes like any popover. Behaviour runs in the narrowest
// window (900px); the layout checks at the end run at every size.
import type { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";
import { createMemoryHistory } from "@tanstack/react-router";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter, type AppRouter } from "~/router";
import { answerRpc, ENVIRONMENT_ID, type FakeDriver } from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { keepBrowserStorage } from "../test/browserStorage";
import { expectTabsToldApart } from "../test/tabNames";
import {
  expectClickable,
  expectInside,
  expectNoOverlap,
  expectNoPageScroll,
  forEachViewport,
  numbered,
  windowRect,
} from "../test/viewports";
import { TABS_STORAGE_KEY } from "./tabs.logic";
import { __reloadTabsForTests, keep, pin, useTabsStore } from "./tabsStore";

// App imports start primary discovery, so its HTTP fixture must already be installed.
const { THREAD, OTHER } = await vi.hoisted(async () => {
  const { installFakeEnvironment, threadWithHistory } =
    await import("../../../test/fakeEnvironment");
  const THREAD = threadWithHistory("thread-narrow", 3);
  const OTHER = threadWithHistory("thread-narrow-other", 2);
  installFakeEnvironment([THREAD, OTHER]);
  return { THREAD, OTHER };
});

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

answerRpc("plugins.levels", () => Effect.succeed([{ source: "banneret", level: "read_write" }]));
// Each layout test gives browser storage back as this file found it. They come last in the file, so
// the next file's stores load none of what the app here saved.
const asFound = keepBrowserStorage();
localStorage.removeItem(TABS_STORAGE_KEY);
__reloadTabsForTests();
await page.viewport(900, 700);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

const router: AppRouter = getRouter(
  createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${THREAD.id}`] }),
);
await router.load();
const container = document.createElement("div");
container.style.cssText = "height: 100dvh; width: 100%;";
await render(<AppRoot router={router} />, { container, router: false });

const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
const activeTab = () => document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
const tabNamed = (text: string) => tabs().find((tab) => tab.textContent?.startsWith(text))!;
const names = () => tabs().map((tab) => tab.textContent);
const closeButton = (tab: HTMLElement) =>
  tab.querySelector<HTMLElement>('button[aria-label^="Close "]')!;
const threadPath = (threadId: ThreadId) => `/${ENVIRONMENT_ID}/${threadId}`;

async function go(to: string) {
  await act(() => router.navigate({ href: to }));
}

/** Opens and keeps one tab per path, in order, from an empty bar; the last stays active. */
async function openTabs(...paths: ReadonlyArray<string>) {
  await go("/pull-requests");
  await act(() => useTabsStore.setState({ tabs: [], activeId: null }));
  for (const path of paths) {
    const count = tabs().length;
    await go(path);
    await vi.waitFor(() => expect(tabs()).toHaveLength(count + 1));
    await act(() => keep(activeTab().dataset.tabId!));
  }
}

// More tabs than 900px holds, ending on a short title.
const CROWDED = [
  threadPath(THREAD.id),
  threadPath(OTHER.id),
  "/today",
  "/board",
  "/feed",
  "/needs",
  "/team",
  "/map",
];

describe("closing tabs in a narrow window", () => {
  it("keeps the active tab's close button in reach while it is hovered", async () => {
    await openTabs(...CROWDED);
    const list = document.querySelector('[role="tablist"]')!;
    expect(list.scrollWidth).toBeGreaterThan(list.clientWidth);
    const tab = activeTab();
    await userEvent.unhover(tab);
    const width = tab.getBoundingClientRect().width;
    await userEvent.hover(tab);
    expect(tab.getBoundingClientRect().width).toBe(width);
    expectClickable(closeButton(tab), "the close button");
    await userEvent.click(closeButton(tab));
    await vi.waitFor(() => expect(tab.isConnected).toBe(false));
  });

  it("offers close on a hovered inactive tab without changing its width", async () => {
    await openTabs(threadPath(THREAD.id), "/today", "/map");
    const tab = tabNamed("Today");
    const width = tab.getBoundingClientRect().width;
    await userEvent.hover(tab);
    expect(tab.getBoundingClientRect().width).toBe(width);
    expectClickable(closeButton(tab), "the close button");
    await userEvent.click(closeButton(tab));
    await vi.waitFor(() => expect(tabs()).toHaveLength(2));
  });

  it("keeps a pinned active tab closable", async () => {
    await openTabs(...CROWDED);
    await act(() => pin(activeTab().dataset.tabId!));
    await userEvent.hover(activeTab());
    expectClickable(closeButton(activeTab()), "the close button");
  });

  it("brings the active tab back into view when the window narrows", async () => {
    await page.viewport(1400, 700);
    try {
      await openTabs(...CROWDED);
    } finally {
      await page.viewport(900, 700);
    }
    await vi.waitFor(() => expectClickable(closeButton(activeTab()), "the close button"));
  });

  it("closes from the keyboard when Enter is pressed on the close button", async () => {
    await openTabs(threadPath(THREAD.id), "/today", "/map");
    closeButton(activeTab()).focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(tabs()).toHaveLength(2));
  });
});

const menuItem = (name: string) => page.getByRole("menuitem", { name, exact: true });

async function openMenu(tab: HTMLElement) {
  await userEvent.click(tab, { button: "right" });
  await expect.element(page.getByRole("menu")).toBeVisible();
}

async function choose(tab: HTMLElement, item: string) {
  await openMenu(tab);
  await menuItem(item).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
}

describe("tab context menu", () => {
  it("lists the actions on right-click without activating the tab", async () => {
    await openTabs(threadPath(THREAD.id), "/today", "/map");
    await openMenu(tabNamed("Today"));
    for (const item of [
      "Close",
      "Close others",
      "Close to the right",
      "Pin",
      "Keep",
      "Copy link",
    ]) {
      await expect.element(menuItem(item)).toBeVisible();
    }
    await expect.element(menuItem("Keep")).toHaveAttribute("aria-disabled", "true");
    expect(router.state.location.pathname).toBe("/map");
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the tab that was right-clicked", async () => {
    await openTabs(threadPath(THREAD.id), "/today", "/map");
    await choose(tabNamed("Today"), "Close");
    await vi.waitFor(() => expect(tabNamed("Today")).toBeUndefined());
    expect(router.state.location.pathname).toBe("/map");
  });

  it("closes the others, spares pinned tabs and shows the chosen tab", async () => {
    await openTabs(threadPath(THREAD.id), "/today", "/board", "/map");
    await act(() => pin(tabNamed("Today").dataset.tabId!));
    const chosen = tabNamed("Board");
    await choose(chosen, "Close others");
    await vi.waitFor(() => {
      expect(tabs()).toHaveLength(2);
      expect(activeTab()).toBe(chosen);
      expect(router.state.location.pathname).toBe("/board");
    });
    expect(names()[0]).toContain("Today");
  });

  it("closes to the right, spares pinned tabs and leaves the active tab on the left alone", async () => {
    await openTabs("/today", "/board", "/feed", "/map");
    await act(() => pin(tabNamed("Feed").dataset.tabId!));
    await go("/today");
    await choose(tabNamed("Board"), "Close to the right");
    await vi.waitFor(() => expect(tabs()).toHaveLength(3));
    expect(tabNamed("Map")).toBeUndefined();
    expect(router.state.location.pathname).toBe("/today");
  });

  it("shows the chosen tab when closing to the right takes the active one", async () => {
    await openTabs("/today", "/board", "/map");
    await choose(tabNamed("Today"), "Close to the right");
    await vi.waitFor(() => {
      expect(tabs()).toHaveLength(1);
      expect(router.state.location.pathname).toBe("/today");
    });
  });

  it("disables the bulk closes when they would close nothing", async () => {
    await openTabs("/today", "/map");
    await act(() => pin(tabNamed("Today").dataset.tabId!));
    await openMenu(tabNamed("Map"));
    await expect.element(menuItem("Close others")).toHaveAttribute("aria-disabled", "true");
    await expect.element(menuItem("Close to the right")).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
  });

  it("pins and unpins", async () => {
    await openTabs("/today", "/map");
    const tab = tabNamed("Today");
    await choose(tab, "Pin");
    await vi.waitFor(() => expect(tab.dataset.pinned).toBe(""));
    await choose(tab, "Unpin");
    await vi.waitFor(() => expect(tab.dataset.pinned).toBeUndefined());
  });

  it("keeps a preview tab", async () => {
    await openTabs("/today");
    await go("/map");
    await vi.waitFor(() => expect(activeTab().dataset.preview).toBe(""));
    await choose(activeTab(), "Keep");
    await vi.waitFor(() => expect(activeTab().dataset.preview).toBeUndefined());
  });

  it("copies a thread tab's link, and a page tab's address", async () => {
    await openTabs(threadPath(THREAD.id), "/today");
    const copied: string[] = [];
    const chips: boolean[] = [];
    using _write = vi.spyOn(navigator.clipboard, "write").mockImplementation(async ([item]) => {
      copied.push(await (await item!.getType("text/plain")).text());
      chips.push(item!.types.some((type) => type.includes(COMPOSER_CONTEXT_CLIPBOARD_MIME)));
    });
    using _writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockImplementation(async (text) => {
        copied.push(text);
      });
    await choose(tabNamed(THREAD.title), "Copy link");
    await vi.waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toMatch(new RegExp(`/threads/${ENVIRONMENT_ID}/${THREAD.id}$`));
    await choose(tabNamed("Today"), "Copy link");
    await vi.waitFor(() => expect(copied).toHaveLength(2));
    expect(copied[1]).toBe(`${window.location.origin}/today`);
  });

  it.each(["{Shift>}{F10}{/Shift}", "{ContextMenu}"])(
    "opens from the keyboard with %s, and Escape returns focus to the tab",
    async (keys) => {
      await openTabs("/today", "/map");
      activeTab().focus();
      await userEvent.keyboard(keys);
      await expect.element(page.getByRole("menu")).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
      await vi.waitFor(() => expect(document.activeElement).toBe(activeTab()));
    },
  );

  it("reaches another tab's menu with the arrow keys and runs an item with Enter", async () => {
    await openTabs("/today", "/map");
    activeTab().focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tabNamed("Today"));
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Close"));
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(tabs()).toHaveLength(1));
    expect(router.state.location.pathname).toBe("/map");
  });
});

const trigger = () => page.getByRole("button", { name: "Tool access" });
const selector = () => page.getByRole("combobox", { name: "Banneret tools" });

describe("tool access panel", () => {
  async function open() {
    await go(threadPath(THREAD.id));
    await trigger().click();
    await expect.element(selector()).toBeVisible();
  }

  it("sits clear of the breadcrumb and opens under its button", async () => {
    await open();
    const header = document.querySelector("[data-chat-header]")!.getBoundingClientRect();
    const button = trigger().element().getBoundingClientRect();
    expect(button.top).toBeGreaterThanOrEqual(header.bottom + 3);
    expect(button.left).toBeGreaterThanOrEqual(header.left + 8);
    const popup = document.querySelector('[data-slot="popover-popup"]')!.getBoundingClientRect();
    expect(popup.top).toBeGreaterThanOrEqual(button.bottom);
    expect(popup.left).toBeCloseTo(button.left, 0);
    await userEvent.keyboard("{Escape}");
  });

  it("closes on Escape", async () => {
    await open();
    await userEvent.keyboard("{Escape}");
    await expect.element(selector()).not.toBeInTheDocument();
  });

  it("closes on a click outside", async () => {
    await open();
    await userEvent.click(document.querySelector<HTMLElement>('[contenteditable="true"]')!);
    await expect.element(selector()).not.toBeInTheDocument();
  });

  it("closes when its button is pressed again", async () => {
    await open();
    await trigger().click();
    await expect.element(selector()).not.toBeInTheDocument();
  });
});

/** One layout test's bar: it starts the test's own tabs and leaves none, in memory or saved. */
function ownTabs(): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      try {
        await go("/pull-requests");
        await act(() => useTabsStore.setState({ tabs: [], activeId: null }));
      } finally {
        asFound[Symbol.dispose]();
      }
    },
  };
}

// Twenty tabs with long names overflow the bar even at 3840px. The last, short one is active.
async function fillBar() {
  await openTabs();
  const filler = Array.from({ length: 19 }, (_, index) => ({
    id: `filler-${index}`,
    kind: "thread" as const,
    href: `/${ENVIRONMENT_ID}/filler-${index}`,
    workspaceId: null,
    threadRef: { environmentId: ENVIRONMENT_ID, threadId: `filler-${index}` },
    title: `A thread with a long name that fills its tab ${index}`,
    pinned: index === 18,
    kept: true,
    lastActiveAt: index,
  }));
  await act(() => useTabsStore.setState({ tabs: filler, activeId: null }));
  await go("/map");
  await vi.waitFor(() => expect(tabs()).toHaveLength(20));
  await act(() => keep(activeTab().dataset.tabId!));
}

/** The sidebar, the tabs bar and the page share the window without covering or cutting each other. */
function expectLayout() {
  expectNoPageScroll();
  const sidebar = document
    .querySelector('[data-slot="sidebar-container"]')!
    .getBoundingClientRect();
  const bar = document.querySelector("[data-banneret-tabs-bar]")!.getBoundingClientRect();
  expect(bar.top).toBe(0);
  expect(bar.left).toBeCloseTo(sidebar.right, 0);
  expect(bar.right).toBe(window.innerWidth);
  for (const inset of document.querySelectorAll('[data-slot="sidebar-inset"]')) {
    const box = inset.getBoundingClientRect();
    expect(box.top).toBe(bar.bottom);
    expect(box.bottom).toBe(window.innerHeight);
    expect(box.left).toBeGreaterThanOrEqual(sidebar.right - 0.5);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  }
  const list = document.querySelector('[role="tablist"]')!;
  const options = page.getByRole("button", { name: "Tabs bar options" }).element();
  expectNoOverlap({ "the tab list": list, "the options button": options });
  expectInside(options, bar, "the options button");
  expectClickable(options, "the options button");
  expectNoOverlap(numbered("tab", tabs()));
  for (const tab of tabs()) {
    const box = tab.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(bar.top);
    expect(box.bottom).toBeLessThanOrEqual(bar.bottom);
    const parts = [...tab.querySelectorAll(":scope > span, :scope > button")].filter((part) =>
      part.checkVisibility(),
    );
    for (const part of parts) expectInside(part, box, "a tab's part");
    expectNoOverlap(numbered("tab part", parts));
  }
}

const ITEMS = ["Close", "Close others", "Close to the right", "Pin", "Keep", "Copy link"];

/** The open menu is whole: inside the window, every item on its own line, uncut and uncovered. */
async function expectMenuFits(items: ReadonlyArray<string> = ITEMS) {
  await expect.element(page.getByRole("menu")).toBeVisible();
  // The popup scales in, so its boxes settle a moment after it is visible.
  await vi.waitFor(() => {
    const popup = document.querySelector('[data-slot="menu-popup"]')!;
    expectInside(popup, windowRect(), "the tab menu");
    const rows = [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(rows.map((row) => row.textContent)).toEqual(items);
    expectNoOverlap(numbered("menu item", rows));
    for (const row of rows) {
      expectInside(row, popup.getBoundingClientRect(), row.textContent);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      if (row.getAttribute("aria-disabled") !== "true") expectClickable(row, row.textContent);
    }
    const scroller = popup.firstElementChild!;
    expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight);
  });
}

forEachViewport("every tab's close button stays in reach", async (at) => {
  await using _tabs = ownTabs();
  await openTabs(threadPath(THREAD.id), "/today", "/map");
  await vi.waitFor(expectLayout);
  await userEvent.hover(activeTab());
  expectClickable(closeButton(activeTab()), "the close button");

  await fillBar();
  const list = document.querySelector('[role="tablist"]')!;
  expect(list.scrollWidth).toBeGreaterThan(list.clientWidth);
  // Measured before any hover: the bar itself keeps the active tab in view.
  await vi.waitFor(() => expectClickable(closeButton(activeTab()), "the close button"));
  await at.screenshot();
  for (const tab of tabs()) {
    const width = tab.getBoundingClientRect().width;
    await userEvent.hover(tab);
    expect(tab.getBoundingClientRect().width).toBe(width);
    expectClickable(closeButton(tab), "the close button");
  }
  expectLayout();
  const last = activeTab();
  await userEvent.hover(last);
  await userEvent.click(closeButton(last));
  await vi.waitFor(() => expect(tabs()).toHaveLength(19));
  expectLayout();
});

forEachViewport("chat tabs with a shared start show the part that differs", async (at) => {
  await using _tabs = ownTabs();
  await fillBar();
  const alike = tabs().filter((tab) => tab.textContent.startsWith("A thread with a long name"));
  expect(alike).toHaveLength(19);
  await vi.waitFor(expectLayout);
  await at.screenshot();
  // The last one is pinned, which leaves its name the least room.
  await expectTabsToldApart(alike);
});

forEachViewport("the whole tab menu fits at the window's right edge", async (at) => {
  await using _tabs = ownTabs();
  // At the window's right edge, where the menu has the least room.
  await fillBar();
  await vi.waitFor(() => expectClickable(closeButton(activeTab()), "the close button"));
  const box = activeTab().getBoundingClientRect();
  await userEvent.click(activeTab(), {
    button: "right",
    position: { x: box.width - 2, y: box.height / 2 },
  });
  await expectMenuFits();
  await at.screenshot();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
});

describe("tab menu actions in a row", () => {
  it("runs every action from the keyboard and the pointer, down to the last tab", async () => {
    await openTabs("/today", "/board", "/feed");
    await go("/map");
    await vi.waitFor(() => expect(activeTab().dataset.preview).toBe(""));
    activeTab().focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expectMenuFits();
    await menuItem("Keep").click();
    await vi.waitFor(() => expect(activeTab().dataset.preview).toBeUndefined());
    const today = tabNamed("Today");
    await choose(today, "Pin");
    await vi.waitFor(() => expect(today.dataset.pinned).toBe(""));
    await vi.waitFor(expectLayout);
    await choose(today, "Unpin");
    await vi.waitFor(() => expect(today.dataset.pinned).toBeUndefined());
    const copied: string[] = [];
    using _writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockImplementation(async (text) => {
        copied.push(text);
      });
    await choose(today, "Copy link");
    await vi.waitFor(() => expect(copied).toEqual([`${window.location.origin}/today`]));
    await choose(tabNamed("Board"), "Close to the right");
    await vi.waitFor(() => {
      expect(tabs()).toHaveLength(2);
      expect(router.state.location.pathname).toBe("/board");
    });
    await choose(tabNamed("Today"), "Close others");
    await vi.waitFor(() => {
      expect(tabs()).toHaveLength(1);
      expect(router.state.location.pathname).toBe("/today");
    });
    // Closing the last tab goes home, where the app may open a draft with a tab of its own.
    const only = activeTab();
    await choose(only, "Close");
    await vi.waitFor(() => {
      expect(only.isConnected).toBe(false);
      expect(router.state.location.pathname).not.toBe("/today");
    });
  });
});

forEachViewport("Tool access stays clear of the breadcrumb", async (at) => {
  await using _tabs = ownTabs();
  await openTabs(threadPath(THREAD.id));
  await trigger().click();
  await expect.element(selector()).toBeVisible();
  await vi.waitFor(() => {
    expectLayout();
    const header = document.querySelector("[data-chat-header]")!.getBoundingClientRect();
    const button = trigger().element();
    expectInside(button, windowRect(), "Tool access");
    expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(header.bottom + 3);
    const popup = document.querySelector('[data-slot="popover-popup"]')!;
    expectInside(popup, windowRect(), "the tool access panel");
    expect(popup.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      button.getBoundingClientRect().bottom,
    );
  });
  await at.screenshot();
  await userEvent.keyboard("{Escape}");
  await expect.element(selector()).not.toBeInTheDocument();
});
