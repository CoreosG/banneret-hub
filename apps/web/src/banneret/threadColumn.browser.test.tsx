// Banneret Hub: the chat column and the composer share one centred lane. The fork's UI kit loads its
// CSS (ui/tokens.css) before index.css, so it must not let `@layer components` rank below Tailwind's
// base reset, which zeroed the column's auto margins and the timeline's padding.
import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import stylesheet from "~/index.css?inline";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

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

it("keeps the chat column and the composer in one centred lane", async () => {
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  using _style = { [Symbol.dispose]: () => style.remove() };
  const thread = threadWithHistory("thread-column", 6);
  const ref = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1920, 1080);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  // The founder's window: maximised at 1920, details card shown, right panel closed.
  await act(() => useRightPanelStore.getState().close(ref));
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(ref, "inline", true));
  await expect.element(page.getByRole("region", { name: "Thread details" })).toBeVisible();
  await expectSharedLane("1920, card shown");
  const { composer } = lanes();
  // Centred in the canvas right of the sidebar, not pinned to its left edge.
  const canvas = document.querySelector("[data-chat-canvas]")!.getBoundingClientRect();
  expect(composer.left - canvas.left).toBeGreaterThan(48);

  for (const width of [1280, 1920]) {
    await page.viewport(width, 1080);
    await expectSharedLane(`${width} after a resize, card shown`);
  }

  await act(() => useRightPanelStore.getState().setThreadPanelOpen(ref, "inline", false));
  await expectSharedLane("1920, card hidden");

  await act(() => useRightPanelStore.getState().open(ref, "files"));
  await expectSharedLane("1920, right panel open");
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(ref, "inline", true));
  await expectSharedLane("1920, right panel open, card shown");
});
