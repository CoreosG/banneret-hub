import { expect, it, vi } from "vite-plus/test";
import { detailFor, layout } from "./layout";
import { roomCache } from "./roomCache";
import { officePaint } from "./paint";
import { packRooms, pixelRatio, zoomSteps } from "./camera";
import { catalog, createSpriteCache } from "../sprites";

it("packs each row to its rooms and starts the Hallway just below the tallest room", () => {
  const sizes = [
    { width: 312, height: 230 },
    { width: 168, height: 158 },
    { width: 312, height: 230 },
  ];
  const grid = packRooms(sizes);
  expect(grid.positions.map(({ x, y }) => [x, y])).toEqual([
    [0, 0],
    [320, 0],
    [0, 238],
  ]);
  expect(grid).toEqual(packRooms([...sizes]));
  expect([grid.width, grid.height]).toEqual([488, 468]);
});

it("keeps the 500-person, 50-room, 1500-agent office within the sprite and pixel budgets", () => {
  const rooms = Array.from({ length: 50 }, (_, r) =>
    Array.from({ length: 10 }, (_, i) => {
      const id = String(r * 10 + i);
      return {
        person: { id, login: id, role: "staff", sessions: [], machines: [] },
        seated: true,
        info: id,
        sessions: Array.from({ length: 3 }, (_, j) => ({
          personId: id,
          id: id + "/" + j,
          state: "working",
          provider: "codex",
          since: "",
        })),
      };
    }),
  );
  const canvas = document.createElement("canvas").getContext("2d")!;
  const draws = vi.spyOn(canvas, "drawImage");
  const staticDraws = vi.spyOn(OffscreenCanvasRenderingContext2D.prototype, "drawImage");
  const paint = officePaint("light");
  const counts = { working: 30, waiting: 0, idle: 0, notHeardFrom: 0, stopped: 0 };
  for (const zoom of zoomSteps)
    for (const visible of [1, 4, 12, 50]) {
      draws.mockClear();
      staticDraws.mockClear();
      let buttons = 0;
      for (const desks of rooms.slice(0, visible)) {
        const detail = detailFor(zoom, desks, visible);
        const { tiles, items } = layout(desks, detail);
        paint(canvas, desks[0]!.person.id, desks.length, detail, tiles, counts);
        buttons += items.length + 1;
      }
      expect(draws.mock.calls.length + staticDraws.mock.calls.length).toBeLessThanOrEqual(600);
      expect(buttons).toBeLessThanOrEqual(250);
    }
  expect(layout(rooms[0]!, "full")).toEqual(layout([...rooms[0]!], "full"));
  for (const width of [320, 1920, 8192])
    expect(width * pixelRatio(width, 500, 3)).toBeLessThanOrEqual(4096);
  const pictures = roomCache();
  for (let i = 0; i < 50; i++) {
    pictures.get(String(i), () => new OffscreenCanvas(550, 540));
    expect(pictures.bytes).toBeLessThanOrEqual(48 * 1024 * 1024);
  }
  const cache = createSpriteCache();
  const bytes = catalog.reduce((sum, s) => {
    const image = cache.get(s, 2, "light", "full");
    return sum + image.width * image.height * 4;
  }, 0);
  expect(bytes).toBeLessThan(1024 * 1024);
});

it("reuses room backgrounds and sprite images until the theme changes", () => {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const images = vi.spyOn(ctx, "drawImage");
  const counts = { working: 1, idle: 0, waiting: 0, stopped: 0, notHeardFrom: 0 };
  const tiles = [{ x: 0, y: 0, depth: 0, sprite: { kind: "agent", name: "working" } }] as const;
  for (const theme of ["light", "dark"] as const) {
    const paint = officePaint(theme);
    paint(ctx, "one", 1, "full", tiles, counts);
    paint(ctx, "one", 1, "full", tiles, counts);
  }
  const calls = images.mock.calls.map((row) => row[0]);
  expect(calls[0]).toBe(calls[2]);
  expect(calls[1]).toBe(calls[3]);
  expect(calls[4]).not.toBe(calls[0]);
  expect(calls[5]).not.toBe(calls[1]);
  expect(calls[6]).toBe(calls[4]);
  expect(calls[7]).toBe(calls[5]);
});
