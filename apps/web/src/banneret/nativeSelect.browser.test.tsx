import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import appCss from "../index.css?inline";
import "./nativeSelect.css";

/** The painted sRGB of any CSS colour, read back through a canvas. */
function rgb(color: string) {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  // A see-through background is the defect: the system's own list colour would show instead.
  expect(a).toBe(255);
  return [r!, g!, b!];
}
function luminance(color: string) {
  const [r, g, b] = rgb(color).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

it.each(["light", "dark"])("keeps native select options at WCAG AA in %s", async (theme) => {
  using stack = new DisposableStack();
  const style = stack.adopt(document.createElement("style"), (node) => node.remove());
  style.textContent = appCss;
  document.head.append(style);
  document.documentElement.classList.toggle("dark", theme === "dark");
  stack.defer(() => document.documentElement.classList.remove("dark"));
  await using screen = await render(
    <select aria-label="Tool level" className="text-xs">
      <option value="read">Read</option>
    </select>,
  );
  for (const element of [
    screen.getByRole("combobox").element(),
    screen.container.querySelector("option")!,
  ]) {
    const { color, backgroundColor } = getComputedStyle(element);
    const [high, low] = [luminance(color), luminance(backgroundColor)].toSorted((a, b) => b - a);
    expect((high! + 0.05) / (low! + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});
