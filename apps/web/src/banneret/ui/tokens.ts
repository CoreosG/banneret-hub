// Fork UI kit: the type scale, the spacing steps and the tone attributes every kit component uses.
// The colours live in tokens.css.
import "./tokens.css";

/** One colour pair per tone: `ok` success, `info` info, `warn` warning, `error` error, `muted` neutral. */
export type Tone = "ok" | "info" | "warn" | "error" | "muted";

/**
 * How an element wears its tone: `tint` the pill background (8% light, 16% dark), `soft` half of
 * that, `fg` text and icon, `edge` a 40% border, `solid` the full colour.
 */
export type ToneLook = "tint" | "soft" | "fg" | "edge" | "solid";

/** Spread onto an element to give it a tone: `<span {...toneProps("ok", "tint", "fg")} />`. */
export function toneProps(tone: Tone, ...looks: ReadonlyArray<ToneLook>) {
  return { "data-tone": tone, "data-tone-look": looks.join(" ") };
}

/** The type scale as Tailwind classes. Counts and dates add `tabular-nums`. */
export const TYPE = {
  pageTitle: "text-xl font-semibold tracking-tight",
  cardTitle: "text-sm font-medium",
  body: "text-sm",
  meta: "text-xs text-muted-foreground",
  micro: "text-2xs font-medium",
  ref: "font-mono text-2xs text-muted-foreground",
} as const;

/** Type steps Tailwind's scale lacks (13/20), as attributes for tokens.css. */
export const TEXT_SECTION = { "data-text": "section" } as const;
export const TEXT_SUMMARY = { "data-text": "summary" } as const;
/** The 10px radius of sections and board columns. */
export const RADIUS_PANEL = { "data-radius": "panel" } as const;
/** The Board's column grid. */
export const LAYOUT_BOARD_COLUMNS = { "data-layout": "board-columns" } as const;
/** A readable page width, 1200px at most. */
export const LAYOUT_PAGE = { "data-layout": "page" } as const;
/** The Map's stage list on its spine, and one stage row (add `data-spine`). */
export const LAYOUT_MAP_STAGES = { "data-layout": "map-stages" } as const;
export const LAYOUT_MAP_STAGE = { "data-layout": "map-stage" } as const;
/** A 56 x 4px progress bar; set `--progress` (0 to 1) in its style. */
export const LAYOUT_PROGRESS_BAR = { "data-layout": "progress-bar" } as const;
/** The Rests-on view's three columns with arrows between them. */
export const LAYOUT_RESTS_ON = { "data-layout": "rests-on" } as const;

// Spacing uses only Tailwind steps 1, 2, 3, 4, 6, 8 (4 to 32 px): 4 inside chips; 8 between chips,
// rows and cards; 12 card padding and column gaps; 16 header to content and between sections; 24
// page sides and top; 32 page bottom.
