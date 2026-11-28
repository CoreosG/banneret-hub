// Banneret Hub: the viewport matrix for layout browser tests (docs/banneret/maintaining.md, "Layout
// tests"). A layout test runs once at every size below and captures one screenshot per size, saved to
// <repo>/.vitest-viewports/<test>/<size>.png (gitignored, uploaded by CI).
import { expect, it, vi } from "vite-plus/test";
import { cdp, commands, page } from "vite-plus/test/browser";

export interface LayoutViewport {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: 1 | 2;
}

const size = (width: number, height: number, deviceScaleFactor: 1 | 2 = 1): LayoutViewport => ({
  id: `${width}x${height}${deviceScaleFactor === 1 ? "" : `@${deviceScaleFactor}x`}`,
  width,
  height,
  deviceScaleFactor,
});

const LAYOUT_VIEWPORTS: readonly LayoutViewport[] = [
  size(900, 700),
  size(1920, 1080),
  size(2560, 1080),
  size(3440, 1440),
  size(3840, 2160),
  size(3840, 2160, 2),
];

export interface AtViewport extends LayoutViewport {
  /** Saves what the window shows now. `part` tells a second capture of the same size apart. */
  readonly screenshot: (part?: string) => Promise<void>;
}

// Playwright sets a device scale factor per browser context, so one test changes it over the
// DevTools protocol. Vitest types the session as empty; these are the two calls used here.
const devtools = () =>
  cdp() as unknown as {
    send(method: string, params?: Record<string, unknown>): Promise<{ readonly data: string }>;
  };

/** Resizes the test window, and restores the previous size and scale on dispose. */
async function showViewport(viewport: LayoutViewport): Promise<AsyncDisposable> {
  const before = { width: window.innerWidth, height: window.innerHeight };
  const scaled = viewport.deviceScaleFactor !== 1;
  const restore = async () => {
    if (scaled) await devtools().send("Emulation.clearDeviceMetricsOverride");
    await page.viewport(before.width, before.height);
  };
  try {
    await page.viewport(viewport.width, viewport.height);
    if (scaled) {
      await devtools().send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: false,
      });
    }
    // A matrix that silently kept the old size would pass everything, so check what the page sees.
    await vi.waitFor(() =>
      expect([window.innerWidth, window.innerHeight, window.devicePixelRatio]).toEqual([
        viewport.width,
        viewport.height,
        viewport.deviceScaleFactor,
      ]),
    );
  } catch (error) {
    await restore();
    throw error;
  }
  return { [Symbol.asyncDispose]: restore };
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// DevTools captures device pixels; Playwright's own screenshot ignores the scale set above.
async function capture(path: string) {
  // An entrance caught half way through shows a faded page. Spinners never finish and are skipped.
  await Promise.allSettled(
    document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity),
      )
      .map((animation) => animation.finished),
  );
  const { data } = await devtools().send("Page.captureScreenshot", {
    format: "png",
    optimizeForSpeed: true,
  });
  // Relative to apps/web. Vite refuses writes outside the repository.
  await commands.writeFile(`../../.vitest-viewports/${path}`, data, "base64");
}

/**
 * Runs `body` once at every layout viewport, as its own test. The window is resized before the body
 * runs, so the body mounts at that size. The body must call `at.screenshot()` while its UI is up.
 */
export function forEachViewport(name: string, body: (at: AtViewport) => Promise<void>) {
  it.each(LAYOUT_VIEWPORTS)(`[layout] ${name} at $id`, async (viewport) => {
    await using _viewport = await showViewport(viewport);
    const captured: string[] = [];
    await body({
      ...viewport,
      screenshot: async (part) => {
        const path = `${slug(name)}/${viewport.id}${part ? `-${slug(part)}` : ""}.png`;
        await capture(path);
        captured.push(path);
      },
    });
    expect(captured, "a layout test captures every size").not.toEqual([]);
  });
}

// Layout assertions. Boxes are compared in CSS pixels; half a pixel of rounding is allowed.
const SLACK = 0.5;

const describeBox = (box: DOMRect) =>
  `[${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}]`;

function boxOf(element: Element, label: string) {
  const box = element.getBoundingClientRect();
  expect(box.width > 0 && box.height > 0, `${label} is laid out`).toBe(true);
  return box;
}

/** No two of the named elements cover each other. */
export function expectNoOverlap(parts: Readonly<Record<string, Element>>) {
  const boxes = Object.entries(parts).map(
    ([label, element]) => [label, boxOf(element, label)] as const,
  );
  for (const [index, [label, box]] of boxes.entries()) {
    for (const [otherLabel, other] of boxes.slice(index + 1)) {
      const covered =
        Math.min(box.right, other.right) - Math.max(box.left, other.left) > SLACK &&
        Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > SLACK;
      expect(
        covered,
        `${label} ${describeBox(box)} overlaps ${otherLabel} ${describeBox(other)}`,
      ).toBe(false);
    }
  }
}

/**
 * The element shows in full: inside the window and inside every ancestor that cuts off or scrolls its
 * content. `axis: "x"` is for content that scrolls down the page but must never be cut sideways.
 */
export function expectUnclipped(element: Element, label: string, axis: "x" | "both" = "both") {
  const box = boxOf(element, label);
  const inside = (frame: DOMRect | Pick<DOMRect, "left" | "right" | "top" | "bottom">) => ({
    x: box.left >= frame.left - SLACK && box.right <= frame.right + SLACK,
    y: axis === "x" || (box.top >= frame.top - SLACK && box.bottom <= frame.bottom + SLACK),
  });
  const view = inside({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
  expect(view.x && view.y, `${label} ${describeBox(box)} is inside the window`).toBe(true);
  // A fixed element is cut off only by the window.
  for (
    let node: Element | null = element;
    node && getComputedStyle(node).position !== "fixed";
    node = node.parentElement
  ) {
    const parent: Element | null = node.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    const style = getComputedStyle(parent);
    const cutsX = style.overflowX !== "visible";
    const cutsY = style.overflowY !== "visible";
    if (!cutsX && !cutsY) continue;
    const frame = parent.getBoundingClientRect();
    const within = inside(frame);
    expect(
      (!cutsX || within.x) && (!cutsY || within.y),
      `${label} ${describeBox(box)} is clipped by ${parent.tagName.toLowerCase()}.${parent.classList[0] ?? ""} ${describeBox(frame)}`,
    ).toBe(true);
  }
}

/** The control shows in full and a pointer at its centre lands on it, not on something above it. */
export function expectClickable(control: Element, label: string) {
  expectUnclipped(control, label);
  const style = getComputedStyle(control);
  expect(style.visibility, `${label} is visible`).toBe("visible");
  expect(style.pointerEvents, `${label} takes the pointer`).not.toBe("none");
  const box = control.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  expect(
    hit !== null && control.contains(hit),
    `${label} ${describeBox(box)} is covered by ${hit?.outerHTML.slice(0, 120)}`,
  ).toBe(true);
}

function lineBlockOf(element: Element) {
  let node = element;
  while (node.parentElement && ["inline", "contents"].includes(getComputedStyle(node).display)) {
    node = node.parentElement;
  }
  return node;
}

/**
 * No line of prose under `container` is wider than `maxCh` characters (the width of "0" in its own
 * font). Code and tables scroll or wrap by their own rules and are left out.
 */
export function expectReadableLines(container: Element, label: string, maxCh = 90) {
  const lines = new Map<Element, { left: number; right: number; middle: number; text: string }[]>();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim()) continue;
    if (parent.closest("pre, code, table, svg, .sr-only") || !parent.checkVisibility()) continue;
    const block = lineBlockOf(parent);
    const rows = lines.get(block) ?? [];
    lines.set(block, rows);
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1) continue;
      const middle = rect.top + rect.height / 2;
      const row = rows.find((other) => Math.abs(other.middle - middle) < rect.height / 2);
      if (row) {
        row.left = Math.min(row.left, rect.left);
        row.right = Math.max(row.right, rect.right);
        row.text += node.textContent;
      } else {
        rows.push({ left: rect.left, right: rect.right, middle, text: node.textContent });
      }
    }
  }
  const context = document.createElement("canvas").getContext("2d")!;
  let measured = 0;
  for (const [block, rows] of lines) {
    const style = getComputedStyle(block);
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const ch = context.measureText("0").width;
    const frame = block.getBoundingClientRect();
    for (const row of rows) {
      // A truncated line ends where its block does.
      const width = Math.min(row.right, frame.right) - Math.max(row.left, frame.left);
      expect(
        width / ch,
        `${label}: "${row.text.trim().slice(0, 60)}" is ${Math.round(width / ch)}ch wide`,
      ).toBeLessThanOrEqual(maxCh);
      measured += 1;
    }
  }
  expect(measured, `${label} has text to measure`).toBeGreaterThan(0);
}

/**
 * `content` sits in the middle of `frame`: the empty space left and right of it differs by no more
 * than `tolerance` pixels, so a wide window never leaves one large empty side.
 */
export function expectCentred(content: Element, frame: Element, label: string, tolerance = 16) {
  const inner = boxOf(content, `${label} content`);
  const outer = boxOf(frame, `${label} frame`);
  const left = inner.left - outer.left;
  const right = outer.right - inner.right;
  expect(
    Math.abs(left - right),
    `${label} is centred (${Math.round(left)}px left, ${Math.round(right)}px right)`,
  ).toBeLessThanOrEqual(tolerance);
}
