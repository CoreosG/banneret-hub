// Banneret Hub: the `/` company search in the real app (AppRoot with the app's router, against the
// in-process environment): it opens from every Enterprise page after a click on empty page space,
// with the layouts that type `/` through AltGr, with the sidebar shut, from the page header's
// Search button and from the command palette.
import {
  BANNERET_WORKSPACES_WS_METHODS,
  type BanneretEnrolmentView,
  type BanneretFeedState,
  type BanneretWorkspace,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { createMemoryHistory } from "@tanstack/react-router";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { openCommandPalette } from "~/commandPaletteBus";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter, type AppRouter } from "~/router";
import {
  answerRpc,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { useCompanySearchStore } from "./companySearchStore";
import { storeEnrolmentView } from "./enrolmentStore";
import { feedRpc } from "./relayFeedStore";
import { TABS_STORAGE_KEY } from "./tabs/tabs.logic";
import { __reloadTabsForTests } from "./tabs/tabsStore";
import { useWorkspacesStore } from "./workspacesStore";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const WORKSPACE_ID = "ent-0123456789abcdef";
const RELAY_ORIGIN = "https://relay.example.com";
const COMPANY: BanneretWorkspace = {
  id: WORKSPACE_ID,
  name: "Example Company",
  kind: "enterprise",
  projectKeys: [],
  updatedAt: "2026-11-26T10:00:00.000Z",
  relay: { origin: RELAY_ORIGIN, displayName: "Example Company" },
};
const JOINED: BanneretEnrolmentView = {
  state: "configured",
  workspaceId: WORKSPACE_ID,
  relayOrigin: RELAY_ORIGIN,
  displayName: "Example Company",
  machineId: "m_1",
  label: "Ada laptop",
  me: { login: "ada-example", role: "founder" },
};
const FEED: BanneretFeedState = {
  joined: true,
  live: true,
  since: "2026-11-26T09:59:00.000Z",
  sectionsKnown: true,
  sections: ["today", "needs", "board", "map", "feed"],
  needsCount: null,
  revision: 1,
  board: null,
  map: null,
  feed: null,
  graveyard: null,
};

installFakeEnvironment([threadWithHistory("thread-search", 2)]);
answerRpc(BANNERET_WORKSPACES_WS_METHODS.list, () => Effect.succeed({ workspaces: [COMPANY] }));
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});
const listeners = new Set<(event: BanneretFeedState) => void>();
const nothing = { joined: true, value: null, fetchedAt: null };
vi.spyOn(feedRpc, "today").mockResolvedValue(nothing);
vi.spyOn(feedRpc, "needs").mockResolvedValue(nothing);
vi.spyOn(feedRpc, "subscribe").mockImplementation((_target, listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
});
localStorage.removeItem(TABS_STORAGE_KEY);
__reloadTabsForTests();
await page.viewport(1165, 900);

async function mountApp(): Promise<AppRouter> {
  const router = getRouter(createMemoryHistory({ initialEntries: ["/today"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 100%;";
  await render(<AppRoot router={router} />, { container, router: false });
  // The environment's own enrolment read may land after the app mounts; this machine has joined.
  await vi.waitFor(
    () => {
      storeEnrolmentView(ENVIRONMENT_ID, JOINED);
      if (useWorkspacesStore.getState().activeId !== WORKSPACE_ID) {
        useWorkspacesStore.setState({ activeId: WORKSPACE_ID });
      }
      expect(listeners.size).toBeGreaterThan(0);
    },
    { timeout: 5_000 },
  );
  await act(() => {
    for (const listener of listeners) listener(FEED);
  });
  return router;
}

// One app for the whole file, as a person would use it; each test starts where the last ended.
const router = await mountApp();

const searchDialog = () => document.querySelector('[data-testid="company-search"]');
const pageMain = () => document.querySelector<HTMLElement>('main[data-slot="sidebar-inset"]')!;

async function expectSearchOpensThenClose() {
  await vi.waitFor(() => expect(searchDialog()).not.toBeNull());
  await expect
    .element(page.getByRole("combobox", { name: "Search Example Company" }))
    .toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(searchDialog()).toBeNull());
}

/** A click on blank space near the page's bottom right corner, away from every control. */
async function clickEmptySpace() {
  const main = pageMain();
  const box = main.getBoundingClientRect();
  await userEvent.click(main, { position: { x: box.width - 24, y: box.height - 24 } });
  expect(document.activeElement?.closest("input, textarea, [contenteditable]")).toBeNull();
}

describe("company search in the app", () => {
  it("opens with / after a click on empty space on every Enterprise page", async () => {
    const pages = [
      ["Needs you", "/needs"],
      ["Board", "/board"],
      ["Map", "/map"],
      ["Feed", "/feed"],
      ["Today", "/today"],
    ] as const;
    for (const [row, path] of pages) {
      const before = pageMain();
      await userEvent.click(
        page
          .getByRole("navigation", { name: "Threads" })
          .getByRole("button", { name: row, exact: true }),
      );
      await vi.waitFor(() => expect(router.state.location.pathname).toBe(path));
      // Each page draws its own main area; wait for this one, not the page it replaces.
      await vi.waitFor(() => expect(pageMain()).not.toBe(before));
      await clickEmptySpace();
      await userEvent.keyboard("/");
      await expectSearchOpensThenClose();
    }
  });

  it("opens with a / typed through AltGr, as Windows reports it, and not with Ctrl+Alt+Q", async () => {
    await clickEmptySpace();
    const press = (key: string, altGraph: boolean) =>
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: "KeyQ",
          ctrlKey: true,
          altKey: true,
          modifierAltGraph: altGraph,
          bubbles: true,
          cancelable: true,
        } as KeyboardEventInit),
      );
    press("q", false);
    // The key listener decides synchronously; the store would already say open.
    expect(useCompanySearchStore.getState().open).toBe(false);
    press("/", true);
    await expectSearchOpensThenClose();
  });

  it("opens from the page header's Search button and from the command palette", async () => {
    await act(() => router.navigate({ to: "/board" } as never));
    const button = page.getByRole("main").getByRole("button", { name: "Search /" });
    await expect.element(button).toBeVisible();
    await button.click();
    await expectSearchOpensThenClose();

    openCommandPalette({ query: "Search the company" });
    await page.getByRole("option", { name: /Search the company/ }).click();
    await expectSearchOpensThenClose();
  });

  it("still opens with the sidebar shut in a narrow window", async () => {
    await page.viewport(700, 900);
    await vi.waitFor(() =>
      expect(page.getByRole("button", { name: "Board", exact: true }).query()).toBeNull(),
    );
    await clickEmptySpace();
    await userEvent.keyboard("/");
    await expectSearchOpensThenClose();
    await page.viewport(1165, 900);
  });
});
