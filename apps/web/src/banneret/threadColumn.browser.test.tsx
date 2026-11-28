// Banneret Hub: the chat column and the composer share one centred lane. The fork's UI kit loads its
// CSS (ui/tokens.css) before index.css, so it must not let `@layer components` rank below Tailwind's
// base reset, which zeroed the column's auto margins and the timeline's padding.
import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import stylesheet from "~/index.css?inline";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { ENVIRONMENT_ID, type FakeDriver } from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { useTabsStore } from "./tabs/tabsStore";
import { keepBrowserStorage } from "./test/browserStorage";
import {
  expectCentred,
  expectClickable,
  expectReadableLines,
  forEachViewport,
} from "./test/viewports";

// App imports start primary discovery, so its HTTP fixture must already be installed.
const { thread } = await vi.hoisted(async () => {
  const { installFakeEnvironment, threadWithHistory } = await import("../../test/fakeEnvironment");
  const thread = threadWithHistory("thread-column", 6);
  installFakeEnvironment([thread]);
  return { thread };
});

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

function lanes() {
  const scroll = document.querySelector<HTMLElement>(
    "[data-chat-canvas] .messages-timeline-scroll",
  );
  const composer = document.querySelector('[data-chat-composer-stack="true"]');
  const rows = [...(scroll?.querySelectorAll(".chat-content-lane") ?? [])];
  const last = rows
    .map((row) => row.getBoundingClientRect())
    .filter((box) => box.height > 0)
    .toSorted((a, b) => b.bottom - a.bottom)[0];
  if (!scroll || !composer || !last) throw new Error("the thread has not rendered");
  const card = document.querySelector('[aria-label="Thread details"]')?.getBoundingClientRect();
  return { scroll, composer: composer.getBoundingClientRect(), last, card };
}

async function expectSharedLane(label: string) {
  await vi.waitFor(
    () => {
      const { scroll, composer, last, card } = lanes();
      // Follow the end like a reader would after the resize.
      scroll.scrollTop = scroll.scrollHeight;
      const centre = (box: DOMRect) => box.left + box.width / 2;
      expect(Math.abs(centre(last) - centre(composer)), `${label}: centre`).toBeLessThanOrEqual(1);
      expect(Math.abs(last.width - composer.width), `${label}: width`).toBeLessThanOrEqual(1);
      expect(last.bottom, `${label}: last message clears the composer`).toBeLessThanOrEqual(
        composer.top,
      );
      if (card && card.width > 0) {
        expect(last.right, `${label}: column clears the details card`).toBeLessThanOrEqual(
          card.left,
        );
      }
    },
    { timeout: 5000 },
  );
}

forEachViewport("keeps the chat column and the composer in one centred lane", async (at) => {
  // The app saves its panel, tab and draft as it goes; each size starts and ends with none.
  using own = new DisposableStack();
  own.use(keepBrowserStorage());
  const settings = getClientSettings();
  own.defer(() => {
    __setClientSettingsForTests(settings);
    useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
    useTabsStore.setState({ tabs: [], activeId: null });
  });
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "width: 100vw; height: 100vh;";
  await using _app = await render(<AppRoot router={router} />, { container, router: false });

  // The founder's window: maximised, details card asked for, right panel closed. A narrow window
  // shows the card as a sheet or not at all, and the lane checks skip a card that is not there.
  await act(() => useRightPanelStore.getState().close(ref));
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(ref, "inline", true));
  const wide = at.width >= 1280;
  if (wide) {
    await expect.element(page.getByRole("region", { name: "Thread details" })).toBeVisible();
  }
  await expectSharedLane(`${at.id}, card asked for`);

  await act(() => useRightPanelStore.getState().setThreadPanelOpen(ref, "inline", false));
  await expectSharedLane(`${at.id}, card hidden`);
  const { composer, last } = lanes();
  const canvas = document.querySelector("[data-chat-canvas]")!;
  // Centred in the canvas right of the sidebar, not pinned to its left edge.
  await vi.waitFor(() => {
    expectCentred(document.querySelector('[data-chat-composer-stack="true"]')!, canvas, at.id);
  });
  if (canvas.getBoundingClientRect().width > composer.width + 96) {
    expect(composer.left - canvas.getBoundingClientRect().left).toBeGreaterThan(48);
  }
  expect(last.width, "the chat column stays a reading column").toBeLessThanOrEqual(800);
  expectReadableLines(
    document.querySelector("[data-chat-canvas] .messages-timeline-scroll")!,
    "chat messages",
  );
  const toolAccess = page.getByRole("button", { name: "Tool access" }).element();
  expectClickable(toolAccess, "tool access");
  // The fork's row above the timeline starts with the chat column, not at the canvas edge. A narrow
  // window insets the column a little further for the timeline minimap.
  expect(Math.abs(toolAccess.getBoundingClientRect().left - composer.left)).toBeLessThanOrEqual(32);
  expectClickable(
    document.querySelector('[data-chat-composer-stack="true"] [contenteditable="true"]')!,
    "the composer input",
  );
  await at.screenshot();

  if (!wide) return;
  if (at.id === "1920x1080") {
    for (const width of [1280, 1920]) {
      await page.viewport(width, 1080);
      await expectSharedLane(`${width} after a resize, card hidden`);
    }
  }
  await act(() => useRightPanelStore.getState().open(ref, "files"));
  await expectSharedLane(`${at.id}, right panel open`);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(ref, "inline", true));
  await expectSharedLane(`${at.id}, right panel open, card shown`);
});
