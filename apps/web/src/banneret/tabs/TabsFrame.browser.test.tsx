// Banneret Hub: the open tabs bar fits above every page of the real app (AppRoot with the app's
// router, against the in-process environment), with no page scroll and each page fully visible.
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { BANNERET_WORKSPACES_WS_METHODS, type ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { createMemoryHistory } from "@tanstack/react-router";
import type * as Context from "effect/Context";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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

vi.mock("../../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const THREAD = threadWithHistory("thread-tabs", 30);
const environment = installFakeEnvironment([THREAD]);
const workspaces = answerRpc(BANNERET_WORKSPACES_WS_METHODS.list, () => ({ workspaces: [] }));
afterAll(() => {
  workspaces[Symbol.dispose]();
  environment[Symbol.dispose]();
});
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

async function go(router: AppRouter, to: string) {
  await act(() => router.history.push(to));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(to));
}

describe("open tabs frame", () => {
  let router: AppRouter;
  const threadPath = (threadId: ThreadId) => `/${ENVIRONMENT_ID}/${threadId}`;

  it("fits a chat thread; the timeline scrolls inside and header controls stay in the header", async () => {
    router = await mountApp(threadPath(THREAD.id));
    await expect.element(page.getByText(`Answer 29 for ${THREAD.id}.`)).toBeInTheDocument();
    await vi.waitFor(expectFits);
    const header = document.querySelector<HTMLElement>("[data-chat-header]")!;
    const headerBox = header.getBoundingClientRect();
    expect(headerBox.top).toBe(bar()!.getBoundingClientRect().bottom);
    // The timeline is taller than the window, so it scrolls itself instead of the page.
    const scroller = [...document.querySelectorAll<HTMLElement>("[data-chat-column] *")].find(
      (element) =>
        element.scrollHeight > element.clientHeight + 50 &&
        ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
    );
    expect(scroller).toBeDefined();
    // Fixed controls pinned to the title bar follow the header down.
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
    await go(router, `/draft/${draftId}`);
    await vi.waitFor(expectFits);
  });

  for (const path of ["/today", "/board", "/map", "/feed", "/needs", "/pull-requests"]) {
    it(`fits ${path}`, async () => {
      await go(router, path);
      await vi.waitFor(expectFits);
    });
  }

  it("keeps the pull requests header controls level with its header", async () => {
    await go(router, "/pull-requests");
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
    await go(router, "/settings/general");
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
    await go(router, threadPath(THREAD.id));
    await vi.waitFor(expectFits);
    const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
    const control = document.querySelector<HTMLElement>("[data-sidebar-control]")!;
    await act(() => page.getByRole("button", { name: "Toggle main sidebar" }).click());
    await vi.waitFor(() => expect(wrapper.dataset.sidebarState).toBe("collapsed"));
    const header = document.querySelector<HTMLElement>("[data-chat-header]")!.getBoundingClientRect();
    await vi.waitFor(() => {
      expect(control.getBoundingClientRect().top).toBe(header.top);
    });
    expectFits();
    await act(() => page.getByRole("button", { name: "Toggle main sidebar" }).click());
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
