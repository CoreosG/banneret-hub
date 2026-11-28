// Banneret Hub: what a tabs bar owes tabs whose names start the same way.
import { expect, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { expectInside } from "./viewports";

/**
 * Each of these tabs is cut in the middle: its end shows whole and is unlike the others', while its
 * accessible name, close button and tooltip keep the full name.
 */
export async function expectTabsToldApart(tabs: ReadonlyArray<HTMLElement>) {
  expect(tabs.length).toBeGreaterThan(1);
  const ends = tabs.map((tab) => {
    const name = tab.textContent;
    const head = tab.querySelector<HTMLElement>("[data-tab-head]")!;
    const tail = tab.querySelector<HTMLElement>("[data-tab-tail]")!;
    expect(head.scrollWidth, `${name} is cut before its end`).toBeGreaterThan(head.clientWidth);
    expect(tail.scrollWidth, `the end of ${name} shows whole`).toBeLessThanOrEqual(
      tail.clientWidth,
    );
    expectInside(tail, tab.getBoundingClientRect(), `the end of ${name}`);
    expect(page.getByRole("tab", { name, exact: true }).query()).toBe(tab);
    expect(tab.querySelector(`button[aria-label="Close ${name}"]`)).not.toBeNull();
    return tail.textContent;
  });
  expect(new Set(ends).size, `the ends differ: ${ends.join(", ")}`).toBe(tabs.length);
  const [first] = tabs;
  await userEvent.hover(first!);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
      first!.textContent,
    ),
  );
  await userEvent.unhover(first!);
}
