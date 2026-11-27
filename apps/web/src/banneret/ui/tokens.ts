// Fork UI kit: the type scale, the spacing steps and the tone attributes every kit component uses.
// The colours live in tokens.css.
import "./tokens.css";

/** One colour pair per tone: `ok` success, `info` info, `warn` warning, `error` error, `muted` neutral. */
export type Tone = "ok" | "info" | "warn" | "error" | "muted";

/**
 * How an element wears its tone: `tint` the pill background (8% light, 16% dark), `soft` half of
 * that, `fg` text and icon, `edge` a 40% border, `solid` the full colour. In SVG, `fill` and `stroke`
 * paint a shape with the full colour.
 */
export type ToneLook = "tint" | "soft" | "fg" | "edge" | "solid" | "fill" | "stroke";

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

/** Type steps Tailwind's scale lacks (13/20, 16/22), as attributes for tokens.css. */
export const TEXT_SECTION = { "data-text": "section" } as const;
export const TEXT_SUMMARY = { "data-text": "summary" } as const;
/** The dialog title step (16/22), for the Task dialog's heading. */
export const TEXT_DIALOG_TITLE = { "data-text": "dialog-title" } as const;
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
/** Today's two columns (Needs you and Stuck, Working now and Shipped); one column when narrow. */
export const LAYOUT_TODAY_COLUMNS = { "data-layout": "today-columns" } as const;
/** A grid of health tiles, each at least 168px wide. */
export const LAYOUT_HEALTH_TILES = { "data-layout": "health-tiles" } as const;
/** The Stages view's bubble canvas and the Neighbourhood view's graph canvas. */
export const LAYOUT_STAGE_BUBBLES = { "data-layout": "stage-bubbles" } as const;
export const LAYOUT_NEIGHBOURHOOD = { "data-layout": "neighbourhood" } as const;

// Spacing uses only Tailwind steps 1, 2, 3, 4, 6, 8 (4 to 32 px): 4 inside chips; 8 between chips,
// rows and cards; 12 card padding and column gaps; 16 header to content and between sections; 24
// page sides and top; 32 page bottom.
