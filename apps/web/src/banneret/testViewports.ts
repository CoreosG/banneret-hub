// Banneret Hub: the window sizes layout tests run at, and the checks they share.
import { expect, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

export const VIEWPORTS = (
  [
    [900, 700, 1],
    [1920, 1080, 1],
    [2560, 1080, 1],
    [3440, 1440, 1],
    [3840, 2160, 1],
    [3840, 2160, 2],
  ] as const
).map(([width, height, scale]) => ({
  width,
  height,
  scale,
  name: `${width}x${height} at ${scale}x`,
}));

const devtools = () =>
  cdp() as unknown as { send(method: string, params?: object): Promise<unknown> };

/** Sets the window size and device scale factor, and fails unless the page really has them. */
export async function showViewport(size: { width: number; height: number; scale: number }) {
  await devtools().send("Emulation.clearDeviceMetricsOverride");
  await page.viewport(size.width, size.height);
  // The scale goes after the resize, which would reset it.
  if (size.scale !== 1) {
    await devtools().send("Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: size.scale,
      mobile: false,
    });
  }
  await vi.waitFor(() =>
    expect([window.innerWidth, window.innerHeight, window.devicePixelRatio]).toEqual([
      size.width,
      size.height,
      size.scale,
    ]),
  );
}

/** Sub-pixel layout rounding. */
const SLACK = 0.5;

export function expectInside(element: Element, outer: DOMRectReadOnly) {
  const box = element.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.left).toBeGreaterThanOrEqual(outer.left - SLACK);
  expect(box.top).toBeGreaterThanOrEqual(outer.top - SLACK);
  expect(box.right).toBeLessThanOrEqual(outer.right + SLACK);
  expect(box.bottom).toBeLessThanOrEqual(outer.bottom + SLACK);
}

export const windowRect = () => new DOMRect(0, 0, window.innerWidth, window.innerHeight);

/** A click at the element's middle lands on it: nothing covers it. */
export function expectHit(element: Element) {
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  expect(element.contains(hit)).toBe(true);
}

/** Boxes laid out left to right, or top to bottom, never cover each other. */
export function expectNoOverlap(elements: ReadonlyArray<Element>, along: "x" | "y") {
  const boxes = elements
    .map((element) => element.getBoundingClientRect())
    .toSorted((a, b) => (along === "x" ? a.left - b.left : a.top - b.top));
  for (const [index, box] of boxes.entries()) {
    const before = boxes[index - 1];
    if (before === undefined) continue;
    if (along === "x") expect(before.right).toBeLessThanOrEqual(box.left + SLACK);
    else expect(before.bottom).toBeLessThanOrEqual(box.top + SLACK);
  }
}

export function expectNoPageScroll() {
  const root = document.scrollingElement!;
  expect(root.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  expect(root.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
}
