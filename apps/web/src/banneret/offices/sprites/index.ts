import colors from "tailwindcss/colors";
import type { Tone } from "../../ui/tokens";
import { furniture, people, robot, signals } from "./art";

export type Theme = "light" | "dark";
export type Detail = "full" | "simple" | "mark";
const agents = [
  "working",
  "idle",
  "waiting-on-you",
  "waiting-on-someone-else",
  "not-heard-from",
  "stopped",
  "usage-limit",
] as const;
const presence = ["available", "focusing", "away", "off"] as const;
const coats = ["info", "warn", "ok"] as const;
const bodies = ["jacket", "tunic", "hoodie"] as const;
type Sprite =
  | { kind: "object"; name: keyof typeof furniture }
  | { kind: "person"; name: keyof typeof people; coat: (typeof coats)[number] }
  | { kind: "agent"; name: (typeof agents)[number] }
  | { kind: "presence"; name: (typeof presence)[number] };

export const catalog: readonly Sprite[] = [
  ...Object.keys(furniture).map((name) => ({
    kind: "object" as const,
    name: name as keyof typeof furniture,
  })),
  ...bodies.flatMap((name) => coats.map((coat) => ({ kind: "person" as const, name, coat }))),
  ...agents.map((name) => ({ kind: "agent" as const, name })),
  ...presence.map((name) => ({ kind: "presence" as const, name })),
];

export function personForLogin(login: string): Sprite {
  let hash = 2166136261;
  for (const char of login.trim().toLowerCase())
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return {
    kind: "person",
    name: bodies[hash % bodies.length]!,
    coat: coats[Math.floor(hash / bodies.length) % coats.length]!,
  };
}

// Canvas cannot resolve var(). Use the same Tailwind swatches as the kit's foreground tones.
const tones = {
  light: {
    ok: colors.emerald[700],
    warn: colors.amber[700],
    error: colors.red[700],
    info: colors.blue[700],
    muted: colors.zinc[600],
  },
  dark: {
    ok: colors.emerald[400],
    warn: colors.amber[400],
    error: colors.red[400],
    info: colors.blue[400],
    muted: colors.neutral[400],
  },
} satisfies Record<Theme, Record<Tone, string>>;

export const palettes = {
  light: {
    floor: "#f5ede1",
    ink: "#362e3a",
    shade: "#746071",
    wood: "#ab7751",
    leaf: "#386954",
    skin: "#b56f46",
    tones: tones.light,
  },
  dark: {
    floor: "#28263a",
    ink: "#b7aabf",
    shade: "#807796",
    wood: "#c79471",
    leaf: "#8bca97",
    skin: "#efb99a",
    tones: tones.dark,
  },
};

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export const spriteSize = 24;

function stamp(
  ctx: Context,
  pattern: string,
  x: number,
  y: number,
  paints: Readonly<Record<string, string>>,
) {
  const rows = pattern.split(/[\n/]/);
  for (const [dy, row] of rows.entries()) {
    for (let start = 0; start < row.length;) {
      const symbol = row[start]!;
      let end = start + 1;
      while (row[end] === symbol) end++;
      if (symbol !== ".") {
        ctx.fillStyle = paints[symbol]!;
        ctx.fillRect(x + start, y + dy, end - start, 1);
      }
      start = end;
    }
  }
}

/** Position is the top left of a 24 px square. */
export function drawSprite(
  ctx: Context,
  sprite: Sprite,
  x: number,
  y: number,
  scale: number,
  theme: Theme,
  detail: Detail,
) {
  const p = palettes[theme];
  const paints = {
    i: p.ink,
    s: p.shade,
    w: p.wood,
    f: p.floor,
    a: p.tones.info,
    g: p.leaf,
    G: p.tones.ok,
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  if (sprite.kind === "object") {
    const [full, simple, mark] = furniture[sprite.name];
    const pattern = { full, simple, mark }[detail];
    const rows = pattern.split(/[\n/]/);
    stamp(
      ctx,
      pattern,
      Math.floor((spriteSize - Math.max(...rows.map((row) => row.length))) / 2),
      Math.floor((spriteSize - rows.length) / 2),
      paints,
    );
  } else if (sprite.kind === "person") {
    paints.a = p.tones[sprite.coat];
    paints.f = p.skin;
    if (detail === "full") stamp(ctx, people[sprite.name], 7, 5, paints);
    else if (detail === "simple") stamp(ctx, ".sss/.sfs/aaaa/aaaa/.s.s", 10, 9, paints);
    else stamp(ctx, ".i/aaa/.a", 11, 10, paints);
  } else {
    const [tone, glyph] = signals[sprite.name];
    if (sprite.kind === "agent" && detail !== "mark") {
      if (detail === "full") stamp(ctx, robot, 5, 3, paints);
      else
        stamp(
          ctx,
          "...s/ssssssss/sffffffs/sffffffs/sffffffs/sffffffs/sffffffs/ssssssss/.ss..ss",
          8,
          7,
          paints,
        );
    }
    if (sprite.kind === "presence" && detail === "full") {
      stamp(
        ctx,
        "..sssss/.sfffffs/sfffffffs/sfffffffs/sfffffffs/sfffffffs/sfffffffs/.sfffffs/..sssss",
        7,
        7,
        paints,
      );
    }
    const idle = sprite.kind === "agent" && sprite.name === "idle" && detail !== "mark";
    const panel = sprite.kind === "agent" && detail === "full" && !idle;
    if (panel) {
      ctx.fillStyle = p.floor;
      ctx.fillRect(10, 8, 6, 5);
    }
    paints.a = p.tones[tone];
    if (sprite.kind === "presence" && detail === "simple")
      stamp(ctx, ".ssss/sffffs/sffffs/sffffs/sffffs/.ssss", 9, 9, paints);
    if (!idle) stamp(ctx, glyph, panel ? 11 : 10, panel ? 8 : 10, paints);
  }
  ctx.restore();
}

export function createSpriteCache() {
  const entries = new Map<string, OffscreenCanvas>();
  return {
    get(sprite: Sprite, scale: number, theme: Theme, detail: Detail) {
      if (!Number.isFinite(scale) || scale <= 0)
        throw new RangeError("Sprite scale must be positive and finite");
      const key = [
        sprite.kind,
        sprite.name,
        sprite.kind === "person" ? sprite.coat : "",
        scale,
        theme,
        detail,
      ].join("/");
      const existing = entries.get(key);
      if (existing) return existing;
      const size = Math.ceil(spriteSize * scale);
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D unavailable");
      drawSprite(ctx, sprite, 0, 0, scale, theme, detail);
      entries.set(key, canvas);
      return canvas;
    },
    clear() {
      entries.clear();
    },
  };
}
