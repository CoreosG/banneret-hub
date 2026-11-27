import type { OfficeSummary } from "@t3tools/contracts";
import { createSpriteCache, palettes, type Detail, type Theme } from "../sprites";
import { dimensions, type Tile } from "./layout";
import { roomCache } from "./roomCache";

export function officePaint(theme: Theme) {
  const sprites = createSpriteCache(),
    rooms = roomCache(),
    p = palettes[theme];
  function background(count: number, detail: Detail) {
    const { width, height, columns, rows } = dimensions(count);
    const canvas = new OffscreenCanvas(width, height);
    const c = canvas.getContext("2d")!;
    const iso = (a: number, b: number, h = 0) =>
      [12 + rows * 72 + (a - b) * 72, 48 + (a + b) * 36 - h] as const;
    function face(points: readonly (readonly [number, number])[], color: string) {
      c.fillStyle = color;
      c.beginPath();
      points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.closePath();
      c.fill();
      c.strokeStyle = p.shade;
      c.lineWidth = 0.8;
      c.stroke();
    }
    face([iso(0, 0), iso(columns, 0), iso(columns, 0, 28), iso(0, 0, 28)], p.wood);
    face([iso(0, 0), iso(0, rows), iso(0, rows, 28), iso(0, 0, 28)], p.shade);
    // Each wall panel spans one floor tile. Windows follow the same isometric projection.
    if (detail === "full")
      for (let a = 0; a < columns; a++) {
        face(
          [iso(a + 0.12, 0, 7), iso(a + 0.87, 0, 7), iso(a + 0.87, 0, 22), iso(a + 0.12, 0, 22)],
          p.floor,
        );
        face(
          [iso(a + 0.14, 0, 9), iso(a + 0.47, 0, 9), iso(a + 0.47, 0, 20), iso(a + 0.14, 0, 20)],
          p.shade,
        );
      }
    const step = detail === "full" ? 0.5 : 1;
    for (let a = 0; a < columns; a += step)
      for (let b = 0; b < rows; b += step)
        face([iso(a, b), iso(a + step, b), iso(a + step, b + step), iso(a, b + step)], p.floor);
    if (count) {
      // One panel per tile keeps the long notice board behind the desks on that tile.
      for (let b = 0; b < rows; b++) {
        face(
          [iso(0, b + 0.12, 6), iso(0, b + 0.8, 6), iso(0, b + 0.8, 22), iso(0, b + 0.12, 22)],
          p.ink,
        );
        face(
          [iso(0, b + 0.15, 8), iso(0, b + 0.77, 8), iso(0, b + 0.77, 20), iso(0, b + 0.15, 20)],
          p.floor,
        );
        for (const offset of [0.22, 0.42, 0.6]) {
          const [nx, ny] = iso(0, b + offset, 14);
          c.fillStyle = p.tones.info;
          c.fillRect(nx, ny, 4, 3);
        }
      }
      if (detail === "full") {
        const [dx, dy] = iso(columns - 0.08, 0.12);
        c.drawImage(
          sprites.get({ kind: "object", name: "door" }, 2, theme, detail),
          dx - 24,
          dy - 34,
        );
      }
    }
    const [x, y] = count ? iso(0.1, rows - 0.17) : iso(0.1, 0.1);
    c.drawImage(
      sprites.get({ kind: "object", name: count ? "plant" : "door" }, 2, theme, detail),
      x - 24,
      y - 34,
    );
    return canvas;
  }
  return function paint(
    c: CanvasRenderingContext2D,
    key: string,
    count: number,
    detail: Detail,
    tiles: readonly Tile[],
    counts: OfficeSummary["hallway"]["counts"],
  ) {
    c.imageSmoothingEnabled = false;
    if (detail === "mark") {
      c.fillStyle = p.floor;
      c.fillRect(4, 4, 510, 270);
      c.strokeStyle = p.shade;
      c.strokeRect(4, 4, 510, 270);
      const signals = [
        [counts.working, "working"],
        [counts.waiting, "waiting-on-you"],
        [counts.idle, "idle"],
        [counts.notHeardFrom, "not-heard-from"],
        [counts.stopped, "stopped"],
      ] as const;
      let offset = 0;
      for (const [n, name] of signals)
        if (n) {
          c.drawImage(
            sprites.get({ kind: "agent", name }, 2, theme, "mark"),
            16 + offset,
            156,
            120,
            120,
          );
          offset += 84;
        }
      return;
    }
    c.drawImage(
      rooms.get([key, count, detail].join("/"), () => background(count, detail)),
      0,
      0,
    );
    for (const t of tiles) c.drawImage(sprites.get(t.sprite, 2, theme, detail), t.x - 24, t.y - 27);
  };
}
