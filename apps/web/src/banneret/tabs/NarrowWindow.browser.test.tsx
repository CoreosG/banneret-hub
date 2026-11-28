// Banneret Hub: a narrow window (900px) in the real app. A tab can always be closed, tabs have a
// context menu, and the thread's Tool access panel closes like any popover.
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

/** The button is inside the tab list's visible box and is what a click at its middle hits. */
function expectClickable(button: HTMLElement) {
  const list = document.querySelector('[role="tablist"]')!.getBoundingClientRect();
  const box = button.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  expect(box.left).toBeGreaterThanOrEqual(list.left - 0.5);
  expect(box.right).toBeLessThanOrEqual(list.right + 0.5);
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  expect(button.contains(hit)).toBe(true);
}

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
    expectClickable(closeButton(tab));
    await userEvent.click(closeButton(tab));
    await vi.waitFor(() => expect(tab.isConnected).toBe(false));
  });

  it("offers close on a hovered inactive tab without changing its width", async () => {
    await openTabs(threadPath(THREAD.id), "/today", "/map");
    const tab = tabNamed("Today");
    const width = tab.getBoundingClientRect().width;
    await userEvent.hover(tab);
    expect(tab.getBoundingClientRect().width).toBe(width);
    expectClickable(closeButton(tab));
    await userEvent.click(closeButton(tab));
    await vi.waitFor(() => expect(tabs()).toHaveLength(2));
  });

  it("keeps a pinned active tab closable", async () => {
    await openTabs(...CROWDED);
    await act(() => pin(activeTab().dataset.tabId!));
    await userEvent.hover(activeTab());
    expectClickable(closeButton(activeTab()));
  });

  it("brings the active tab back into view when the window narrows", async () => {
    await page.viewport(1400, 700);
    try {
      await openTabs(...CROWDED);
    } finally {
      await page.viewport(900, 700);
    }
    await vi.waitFor(() => expectClickable(closeButton(activeTab())));
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
