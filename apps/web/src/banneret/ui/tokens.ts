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

// Spacing uses only Tailwind steps 1, 2, 3, 4, 6, 8 (4 to 32 px): 4 inside chips; 8 between chips,
// rows and cards; 12 card padding and column gaps; 16 header to content and between sections; 24
// page sides and top; 32 page bottom.
