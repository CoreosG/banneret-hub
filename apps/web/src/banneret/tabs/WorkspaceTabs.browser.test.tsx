// Banneret Hub: "Tabs show: Workspaces" in the real app (AppRoot with the app's router, against the
// in-process environment): switching from Settings, one tab per project, each with its last chat,
// the sidebar narrowed to the shown one, and the tab actions.
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProjectId, type BanneretWorkspace, type ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { createMemoryHistory } from "@tanstack/react-router";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter, type AppRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import { ENVIRONMENT_ID, type FakeDriver } from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import {
  expectClickable,
  expectInside,
  expectNoOverlap,
  expectNoPageScroll,
  expectUnclipped,
  forEachViewport,
  numbered,
  windowRect,
} from "../test/viewports";
import { setActiveWorkspace, useWorkspacesStore } from "../workspacesStore";
import { TABS_STORAGE_KEY } from "./tabs.logic";
import { __reloadTabsForTests, setTabsHidden, useTabsStore } from "./tabsStore";
import { NO_PROJECT_KEY, WORKSPACE_TABS_STORAGE_KEY } from "./workspaceTabs.logic";
import { showChatTabs } from "./workspaceTabsActions";
import { __reloadWorkspaceTabsForTests, useWorkspaceTabsStore } from "./workspaceTabsStore";

const LONG_NAMES = Array.from(
  { length: 9 },
  (_, index) => `customer-billing-reconciliation-service-${index}`,
);

// App imports start primary discovery, so its HTTP fixture must already be installed.
const { THREAD, OTHER } = await vi.hoisted(async () => {
  const { installFakeEnvironment, threadWithHistory } =
    await import("../../../test/fakeEnvironment");
  const THREAD = threadWithHistory("thread-tabs", 4);
  const OTHER = threadWithHistory("thread-other", 2);
  const named = (title: string) => ({ id: `project-${title}` as never, title });
  installFakeEnvironment([THREAD, OTHER], {
    extraProjects: [
      named("web"),
      named("api"),
      { ...named("No project"), isScratch: true } as { id: never; title: string },
      ...Array.from({ length: 9 }, (_, index) =>
        named(`customer-billing-reconciliation-service-${index}`),
      ),
    ],
  });
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

localStorage.removeItem(TABS_STORAGE_KEY);
localStorage.removeItem(WORKSPACE_TABS_STORAGE_KEY);
__reloadTabsForTests();
__reloadWorkspaceTabsForTests();
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

/** A chat in another project: an unsent draft with text, which the sidebar lists. */
function draftIn(project: string, text = `Plan the ${project} work`, suffix = "") {
  const draftId = DraftId.make(`draft-${project.replaceAll(" ", "-")}${suffix}`);
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(
    scopeProjectRef(ENVIRONMENT_ID, ProjectId.make(`project-${project}`)),
    draftId,
  );
  drafts.setPrompt(draftId, text);
  return `/draft/${draftId}`;
}

async function mountApp(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 100vh; width: 100vw;";
  await render(<AppRoot router={router} />, { container, router: false });
  return router;
}

const threadPath = (threadId: ThreadId) => `/${ENVIRONMENT_ID}/${threadId}`;
const tablist = (name: string) =>
  document.querySelector<HTMLElement>(`[role="tablist"][aria-label="${name}"]`);
const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
const tabTitles = () => tabs().map((tab) => tab.textContent);
const tabNamed = (title: string) => tabs().find((tab) => tab.textContent === title)!;
const activeTitle = () =>
  document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent;
const sidebar = () => document.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
const sidebarText = () => sidebar().textContent ?? "";
const path = () => router.state.location.pathname;

/** The sidebar lists the chats of exactly these of the three projects with chats. */
async function expectSidebarLists(...projects: Array<"render" | "web" | "api">) {
  const marks = {
    render: [THREAD.title, OTHER.title],
    web: ["Plan the web work"],
    api: ["Plan the api work"],
  };
  await vi.waitFor(() => {
    for (const [project, texts] of Object.entries(marks)) {
      for (const text of texts) {
        const listed = sidebarText().includes(text);
        expect([text, listed]).toEqual([text, projects.includes(project as "web")]);
      }
    }
  });
}

const router: AppRouter = await mountApp(threadPath(THREAD.id));

async function go(to: string) {
  await act(() => router.navigate({ href: to }));
}

/** Chooses in Settings → Appearance → Tabs show, then leaves Settings. */
async function chooseTabsShow(label: "Chats" | "Workspaces") {
  const back = path();
  await go("/settings/appearance");
  await page.getByRole("combobox", { name: "Tabs show" }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect.element(page.getByRole("combobox", { name: "Tabs show" })).toHaveTextContent(label);
  await go(back);
  await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
}

/** Drops every unsent chat: the next test file shares this browser storage and would list them. */
async function discardDrafts() {
  await go(threadPath(THREAD.id));
  await act(() => {
    const store = useComposerDraftStore.getState();
    for (const id of Object.keys(store.draftThreadsByThreadKey)) {
      store.clearDraftThread(DraftId.make(id));
    }
  });
}

/**
 * The web and api chats under Workspaces tabs, for one layout test: CI runs those without the tests
 * above them. The next test file gets Chats tabs and no drafts back.
 */
async function workspacesFixture(): Promise<AsyncDisposable> {
  draftIn("web");
  draftIn("api");
  await chooseTabsShow("Workspaces");
  return {
    async [Symbol.asyncDispose]() {
      await act(() => showChatTabs());
      await discardDrafts();
    },
  };
}

async function menuOn(title: string, item: string) {
  await userEvent.click(tabNamed(title), { button: "right" });
  await page.getByRole("menuitem", { name: item, exact: true }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
}

async function pickWorkspace(name: string) {
  await page.getByRole("button", { name: "Workspaces" }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
}

const webDraft = draftIn("web");
const apiDraft = draftIn("api");

describe("Tabs show", () => {
  it("defaults to Chats", async () => {
    await vi.waitFor(() => expect(tablist("Open tabs")).not.toBeNull());
    expect(useWorkspaceTabsStore.getState().mode).toBe("chats");
    expect(tablist("Workspace tabs")).toBeNull();
    expect(page.getByRole("button", { name: "Workspaces" }).query()).toBeNull();
    await expectSidebarLists("render", "web", "api");
  });

  it("switches to Workspaces with a tab per open chat's project, keeping the chat in front", async () => {
    // Three kept chats across two projects, plus a pinned one.
    await userEvent.dblClick(tabNamed(THREAD.title));
    await go(webDraft);
    await userEvent.dblClick(tabs().at(-1)!);
    await go(threadPath(OTHER.id));
    await menuOn(OTHER.title, "Pin");
    await go(threadPath(THREAD.id));
    const before = useTabsStore.getState().tabs;
    expect(before).toHaveLength(3);

    await chooseTabsShow("Workspaces");

    await vi.waitFor(() => expect(tabTitles()).toEqual(["render", "web"]));
    expect(tablist("Open tabs")).toBeNull();
    expect(activeTitle()).toBe("render");
    expect(path()).toBe(threadPath(THREAD.id));
    await expectSidebarLists("render");
    expect(useTabsStore.getState().tabs.map((tab) => tab.id)).toEqual(before.map((t) => t.id));
  });

  it("switches back with the chats tabs as they were", async () => {
    const before = useTabsStore.getState().tabs;
    await chooseTabsShow("Chats");
    await vi.waitFor(() => expect(tablist("Open tabs")).not.toBeNull());
    const after = useTabsStore.getState();
    expect(after.tabs.map((t) => [t.id, t.pinned, t.kept])).toEqual(
      before.map((t) => [t.id, t.pinned, t.kept]),
    );
    expect(after.tabs.find((tab) => tab.id === after.activeId)?.href).toBe(threadPath(THREAD.id));
    expect(activeTitle()).toBe(THREAD.title);
    await expectSidebarLists("render", "web", "api");
  });

  it("keeps the chats preview tab and shows the chat picked while in Workspaces", async () => {
    await menuOn(OTHER.title, "Unpin");
    await userEvent.click(page.getByRole("button", { name: `Close ${OTHER.title}` }));
    await go(threadPath(OTHER.id));
    await vi.waitFor(() => expect(tabNamed(OTHER.title).dataset.preview).toBe(""));
    const previewId = useTabsStore.getState().activeId;

    await chooseTabsShow("Workspaces");
    await go(apiDraft);
    await vi.waitFor(() => expect(activeTitle()).toBe("api"));
    await chooseTabsShow("Chats");

    await vi.waitFor(() => expect(tablist("Open tabs")).not.toBeNull());
    const { tabs: chats, activeId } = useTabsStore.getState();
    expect(chats.find((tab) => tab.id === previewId)).toMatchObject({ kept: true });
    expect(chats.find((tab) => tab.id === activeId)?.href).toBe(apiDraft);
    expect(chats).toHaveLength(4);
  });
});

describe("Workspaces tabs", () => {
  it("returns each workspace to the chat last open in it", async () => {
    await go(threadPath(THREAD.id));
    await chooseTabsShow("Workspaces");
    await go(threadPath(OTHER.id));
    await vi.waitFor(() => expect(activeTitle()).toBe("render"));
    await userEvent.click(tabNamed("web"));
    await vi.waitFor(() => {
      expect(path()).toBe(webDraft);
      expect(activeTitle()).toBe("web");
    });
    await expectSidebarLists("web");
    await userEvent.click(tabNamed("render"));
    await vi.waitFor(() => expect(path()).toBe(threadPath(OTHER.id)));
    await expectSidebarLists("render");
  });

  it("keeps the tabs, the setting and the last chats across a reload", () => {
    const before = useWorkspaceTabsStore.getState();
    __reloadWorkspaceTabsForTests();
    expect(useWorkspaceTabsStore.getState()).toEqual(before);
    expect(before.mode).toBe("workspaces");
  });

  it("brings a chat's workspace to the front however the chat is opened", async () => {
    await go(apiDraft);
    await vi.waitFor(() => expect(activeTitle()).toBe("api"));
    await expectSidebarLists("api");
  });

  it("keeps the shown workspace on a page", async () => {
    await go("/pull-requests");
    await vi.waitFor(() => expect(activeTitle()).toBe("api"));
    await expectSidebarLists("api");
    await userEvent.click(tabNamed("api"));
    await vi.waitFor(() => expect(path()).toBe(apiDraft));
  });

  it("hides a closed tab and brings it back from the workspace list with its chat", async () => {
    await userEvent.click(page.getByRole("button", { name: "Close web" }));
    await vi.waitFor(() => expect(tabTitles()).not.toContain("web"));
    expect(activeTitle()).toBe("api");
    expect(path()).toBe(apiDraft);
    await pickWorkspace("web");
    await vi.waitFor(() => {
      expect(tabTitles().at(-1)).toBe("web");
      expect(activeTitle()).toBe("web");
      expect(path()).toBe(webDraft);
    });
    await expectSidebarLists("web");
  });

  it("shows the neighbour's last chat when the selected tab closes", async () => {
    await userEvent.click(tabNamed("api"));
    await vi.waitFor(() => expect(path()).toBe(apiDraft));
    const drawn = tabTitles();
    const neighbour = drawn[drawn.indexOf("api") + 1] ?? drawn[drawn.indexOf("api") - 1]!;
    tabNamed("api").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await vi.waitFor(() => {
      expect(tabTitles()).not.toContain("api");
      expect(activeTitle()).toBe(neighbour);
    });
    // The chat just left did not bring the closed tab back.
    await vi.waitFor(() => expect(path()).not.toBe(apiDraft));
    expect(tabTitles()).not.toContain("api");
    await pickWorkspace("api");
    await vi.waitFor(() => expect(path()).toBe(apiDraft));
  });

  it("opens the newest chat of a workspace that has no last chat", async () => {
    await userEvent.click(tabNamed("web"));
    await vi.waitFor(() => expect(path()).toBe(webDraft));
    await act(() =>
      useWorkspaceTabsStore.setState((state) => ({
        entries: state.entries.map((entry) =>
          entry.lastChat?.href.startsWith(`/${ENVIRONMENT_ID}/`)
            ? { ...entry, lastChat: null }
            : entry,
        ),
      })),
    );
    await userEvent.click(tabNamed("render"));
    await vi.waitFor(() => expect([threadPath(THREAD.id), threadPath(OTHER.id)]).toContain(path()));
    await expectSidebarLists("render");
  });

  it("starts a draft in a workspace that has no chat", async () => {
    await pickWorkspace(LONG_NAMES[0]!);
    await vi.waitFor(() => {
      expect(path()).toMatch(/^\/draft\//);
      expect(activeTitle()).toBe(LONG_NAMES[0]);
    });
    await expectSidebarLists();
    await menuOn(LONG_NAMES[0]!, "Close");
    await vi.waitFor(() => expect(tabTitles()).not.toContain(LONG_NAMES[0]));
  });

  it("counts No project as a workspace", async () => {
    await go(draftIn("No project", "Sketch an idea"));
    await vi.waitFor(() => expect(activeTitle()).toBe("No project"));
    expect(useWorkspaceTabsStore.getState().activeKey).toBe(NO_PROJECT_KEY);
    await expectSidebarLists();
    await vi.waitFor(() => expect(sidebarText()).toContain("Sketch an idea"));
    await userEvent.click(tabNamed("web"));
    await expectSidebarLists("web");
    expect(sidebarText()).not.toContain("Sketch an idea");
    await menuOn("No project", "Close");
  });

  it("offers the chats menu without Keep, and spares pinned tabs from bulk closes", async () => {
    await userEvent.click(tabNamed("render"));
    await vi.waitFor(() => expect(activeTitle()).toBe("render"));
    await userEvent.click(tabNamed("render"), { button: "right" });
    await expect.element(page.getByRole("menu")).toBeVisible();
    expect(
      page
        .getByRole("menuitem")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["Close", "Close others", "Close to the right", "Pin", "Copy link"]);
    await userEvent.keyboard("{Escape}");
    await menuOn("web", "Pin");
    await vi.waitFor(() => expect(tabNamed("web").dataset.pinned).toBe(""));
    await pickWorkspace(LONG_NAMES[1]!);
    await vi.waitFor(() => expect(activeTitle()).toBe(LONG_NAMES[1]));
    await menuOn("render", "Close others");
    await vi.waitFor(() => {
      expect(tabTitles().toSorted()).toEqual(["render", "web"]);
      expect(activeTitle()).toBe("render");
    });
    await userEvent.click(page.getByRole("button", { name: "Unpin web" }));
    await vi.waitFor(() => expect(tabNamed("web").dataset.pinned).toBeUndefined());
  });

  it("reorders tabs by dragging with the pointer, and closes to the right", async () => {
    await pickWorkspace("api");
    await vi.waitFor(() => expect(tabs()).toHaveLength(3));
    const [first, , third] = tabs();
    const title = first!.textContent;
    const from = first!.getBoundingClientRect();
    const to = third!.getBoundingClientRect();
    const pointer = (target: EventTarget, type: string, x: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          isPrimary: true,
          pointerId: 1,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: from.top + from.height / 2,
        }),
      );
    const startX = from.left + from.width / 2;
    const endX = to.left + to.width / 2 + 2;
    await act(() => pointer(first!, "pointerdown", startX));
    for (let step = 1; step <= 10; step += 1) {
      await act(() => pointer(document, "pointermove", startX + ((endX - startX) * step) / 10));
    }
    await act(() => pointer(document, "pointerup", endX));
    await vi.waitFor(() => expect(tabTitles()[2]).toBe(title));
    const kept = tabTitles()[0]!;
    await menuOn(kept, "Close to the right");
    await vi.waitFor(() => expect(tabTitles()).toEqual([kept]));
    await pickWorkspace("render");
    await pickWorkspace("web");
  });

  it("skips a last chat that no longer exists", async () => {
    // A second web draft takes the project's draft slot, so the shared one is made again after.
    const gone = draftIn("web", "A web draft to discard", "-discarded");
    await go(gone);
    await vi.waitFor(() => expect(activeTitle()).toBe("web"));
    await userEvent.click(tabNamed("render"));
    await vi.waitFor(() => expect(activeTitle()).toBe("render"));
    await act(() =>
      useComposerDraftStore.getState().clearDraftThread(DraftId.make(gone.slice("/draft/".length))),
    );
    await userEvent.click(tabNamed("web"));
    await vi.waitFor(() => {
      expect(activeTitle()).toBe("web");
      expect(path()).toMatch(/^\/draft\//);
    });
    expect(path()).not.toBe(gone);
    await go(draftIn("web"));
  });

  it("moves the workspace switcher with a tab, and follows the switcher back", async () => {
    const company: BanneretWorkspace = {
      id: "ws-company",
      name: "Company",
      kind: "solo",
      projectKeys: [`path:${ENVIRONMENT_ID}:/workspace/api`],
      updatedAt: "2026-11-26T10:00:00.000Z",
    };
    await act(() => useWorkspacesStore.setState({ local: [company] }));
    try {
      await pickWorkspace("api");
      await vi.waitFor(() => {
        expect(useWorkspacesStore.getState().activeId).toBe(company.id);
        expect(activeTitle()).toBe("api");
      });
      await expectSidebarLists("api");
      await userEvent.click(tabNamed("render"));
      await vi.waitFor(() => expect(useWorkspacesStore.getState().activeId).toBeNull());
      await expectSidebarLists("render");
      // The switcher alone hides the render tab's project: the company's own tab is shown.
      await act(() => setActiveWorkspace(company.id));
      await vi.waitFor(() => expect(activeTitle()).toBe("api"));
      await expectSidebarLists("api");
      await userEvent.click(tabNamed("render"));
      await vi.waitFor(() => expect(activeTitle()).toBe("render"));
    } finally {
      await act(() => {
        useWorkspacesStore.setState({ local: [] });
        setActiveWorkspace(null);
      });
    }
  });

  it("leaves the chat on screen when the last tab closes, with the list to bring it back", async () => {
    await userEvent.click(tabNamed("web"));
    await vi.waitFor(() => expect(path()).toBe(webDraft));
    for (const title of tabTitles().filter((title) => title !== "web")) {
      await menuOn(title!, "Close");
    }
    await menuOn("web", "Close");
    await vi.waitFor(() => expect(tabs()).toHaveLength(0));
    expect(path()).toBe(webDraft);
    await expectSidebarLists("render", "web", "api");
    // No home page, so no new draft brought a tab back.
    expect(tabs()).toHaveLength(0);
    await pickWorkspace("web");
    await vi.waitFor(() => expect(tabTitles()).toEqual(["web"]));
    await expectSidebarLists("web");
    await pickWorkspace("render");
  });

  it("lists everything with the bar hidden or in a narrow window", async () => {
    await userEvent.click(tabNamed("web"));
    await expectSidebarLists("web");
    await act(() => setTabsHidden(true));
    await expectSidebarLists("render", "web", "api");
    expect(page.getByRole("button", { name: "Workspaces" }).query()).toBeNull();
    await act(() => setTabsHidden(false));
    await expectSidebarLists("web");
  });

  it("leaves the sidebar's own project folders to the shown workspace", async () => {
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      boringSidebarEnabled: true,
    });
    try {
      await userEvent.click(tabNamed("render"));
      await vi.waitFor(() =>
        expect(
          [...document.querySelectorAll('[data-testid="sidebar-project-folder"]')].map(
            (folder) => folder.querySelector("button .truncate")!.textContent,
          ),
        ).toEqual(["render"]),
      );
      // A scope picked for another project cannot empty this workspace's list.
      await act(() => useUiStateStore.getState().setSidebarProjectScopeKeys(["nowhere"]));
      await expectSidebarLists("render");
    } finally {
      await act(() => useUiStateStore.getState().setSidebarProjectScopeKeys([]));
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      });
    }
  });

  // Keep last: it also leaves this browser storage as the next test file expects it.
  it("lists every chat again after switching back to Chats", async () => {
    await chooseTabsShow("Chats");
    await vi.waitFor(() => expect(tablist("Open tabs")).not.toBeNull());
    await expectSidebarLists("render", "web", "api");
    await discardDrafts();
  });
});

forEachViewport("the sidebar lists only the shown workspace's chats", async (at) => {
  await using _fixture = await workspacesFixture();
  await go(webDraft);
  await go(apiDraft);
  await pickWorkspace("render");
  await go(threadPath(THREAD.id));
  await expectSidebarLists("render");
  await expect.element(page.getByText(`Answer 3 for ${THREAD.id}.`)).toBeInTheDocument();
  expectNoPageScroll();
  await vi.waitFor(() => {
    for (const row of document.querySelectorAll("[data-sidebar-row]")) {
      expectInside(row, sidebar().getBoundingClientRect(), "a sidebar row");
    }
    expectClickable(tabNamed("render"), "the render tab");
    expectClickable(page.getByRole("button", { name: "Workspaces" }).element(), "the list");
  });
  await at.screenshot();
});

/** Every drawn tab's close button works, however many tabs the bar holds. */
function expectBarLayout() {
  expectNoPageScroll();
  const bar = document.querySelector<HTMLElement>("[data-banneret-tabs-bar]")!;
  expectUnclipped(bar, "the bar");
  const options = page.getByRole("button", { name: "Tabs bar options" }).element();
  expectClickable(options, "the options button");
  const list = tablist("Workspace tabs")!;
  expectNoOverlap({ "the tabs": list, "the options button": options });
  expectNoOverlap(numbered("tab", tabs()));
  const selected = document.querySelector('[role="tab"][aria-selected="true"]')!;
  expectInside(selected, list.getBoundingClientRect(), "the selected tab");
  expectClickable(selected.querySelector('button[aria-label^="Close "]')!, "its close button");
}

forEachViewport("workspace tabs, their menu and the workspace list fit", async (at) => {
  await using _fixture = await workspacesFixture();
  await go(webDraft);
  for (const name of ["render", "api", ...LONG_NAMES.slice(2)]) await pickWorkspace(name);
  await vi.waitFor(() => expect(tabs().length).toBeGreaterThanOrEqual(10));
  await vi.waitFor(expectBarLayout);

  await userEvent.click(document.querySelector('[role="tab"][aria-selected="true"]')!, {
    button: "right",
  });
  await expect.element(page.getByRole("menu")).toBeVisible();
  await vi.waitFor(() => {
    expectInside(page.getByRole("menu").element(), windowRect(), "the tab menu");
    for (const item of page.getByRole("menuitem").elements()) {
      // The last tab has nothing to its right.
      if (item.getAttribute("aria-disabled") === "true") continue;
      expectClickable(item, `the ${item.textContent} item`);
    }
  });
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  const trigger = page.getByRole("button", { name: "Workspaces" });
  expectClickable(trigger.element(), "the workspace list button");
  expectInside(trigger.element(), sidebar().getBoundingClientRect(), "the workspace list button");
  await trigger.click();
  await expect.element(page.getByRole("menu")).toBeVisible();
  await vi.waitFor(() => {
    expectInside(page.getByRole("menu").element(), windowRect(), "the workspace list");
    expect(page.getByRole("menuitem").elements()).toHaveLength(13);
  });
  await at.screenshot();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
});

forEachViewport("the Tabs show setting fits Appearance settings", async (at) => {
  await go("/settings/appearance");
  const select = page.getByRole("combobox", { name: "Tabs show" });
  await expect.element(select).toBeVisible();
  select.element().scrollIntoView({ block: "center" });
  await vi.waitFor(() => expectClickable(select.element(), "the Tabs show select"));
  await select.click();
  await vi.waitFor(() => {
    for (const option of page.getByRole("option").elements()) {
      expectClickable(option, `the ${option.textContent} option`);
    }
  });
  await at.screenshot();
  await userEvent.keyboard("{Escape}");
  await go(threadPath(THREAD.id));
});
