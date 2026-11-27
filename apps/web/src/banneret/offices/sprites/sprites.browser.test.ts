import { expect, it } from "vite-plus/test";
import {
  catalog,
  createSpriteCache,
  drawSprite,
  palettes,
  personForLogin,
  spriteSize,
} from "./index";

const themes = ["light", "dark"] as const;
const details = ["full", "simple", "mark"] as const;

it("paints every sprite in bounds and reuses its cached surface", () => {
  const cache = createSpriteCache();
  for (const theme of themes)
    for (const detail of details)
      for (const sprite of catalog) {
        const tile = cache.get(sprite, 2, theme, detail);
        expect(tile).toBe(cache.get(sprite, 2, theme, detail));
        const context = new OffscreenCanvas(52, 52).getContext("2d")!;
        drawSprite(context, sprite, 2, 2, 2, theme, detail);
        const pixels = context.getImageData(2, 2, 48, 48).data;
        expect(pixels.some((value) => value !== 0)).toBe(true);
        expect(pixels).toEqual(tile.getContext("2d")!.getImageData(0, 0, 48, 48).data);
        context.clearRect(2, 2, 48, 48);
        expect(context.getImageData(0, 0, 52, 52).data.some((value) => value !== 0)).toBe(false);
      }
});

it("keeps a login's body and coat stable", () => {
  expect(personForLogin(" Ada ")).toEqual(personForLogin("ada"));
  expect(personForLogin("ada")).toMatchInlineSnapshot(`
    {
      "coat": "info",
      "kind": "person",
      "name": "tunic",
    }
  `);
});

it("preserves key pixel silhouettes", () => {
  const cache = createSpriteCache();
  const samples = [
    ["desk", "simple"],
    ["tunic", "full"],
    ["waiting-on-you", "mark"],
  ] as const;
  const masks = samples.map(([name, detail]) => {
    const sprite = catalog.find((entry) => entry.name === name)!;
    const ctx = cache.get(sprite, 1, "light", detail).getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, spriteSize, spriteSize);
    return Array.from({ length: spriteSize }, (_, y) =>
      Array.from({ length: spriteSize }, (_, x) => (data[(y * spriteSize + x) * 4 + 3] ? "#" : "."))
        .join("")
        .replace(/\.+$/, ""),
    )
      .filter(Boolean)
      .join("\n");
  });
  expect(masks).toMatchInlineSnapshot(`
    [
      "...........##
    ..........####
    .........######
    ........#######
    ........#.###.#
    ........#..#..#
    ...........#",
      "...........###
    ..........#####
    .........#######
    .........#######
    .........#######
    ..........#####
    .........#######
    .........#######
    .........#######
    ........########
    ..........##.##
    ..........##.##
    ..........##.###",
      "...........##
    ...........##
    ...........##
    ...........##",
    ]
  `);
});

function luminance(color: string) {
  const ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data, (byte) => {
    const v = byte / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

it("keeps outlines and every status foreground at 3:1 or better on the floor", () => {
  for (const theme of themes) {
    const palette = palettes[theme];
    const floor = luminance(palette.floor);
    for (const color of [
      palette.ink,
      palette.shade,
      palette.leaf,
      palette.wood,
      palette.skin,
      ...Object.values(palette.tones),
    ]) {
      const fg = luminance(color);
      expect((Math.max(fg, floor) + 0.05) / (Math.min(fg, floor) + 0.05)).toBeGreaterThanOrEqual(3);
    }
  }
});
