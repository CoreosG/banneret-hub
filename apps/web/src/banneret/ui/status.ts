// Fork UI kit: human words for the board's open status vocabulary. Every set is open, so each
// lookup has a fallback that keeps the relay's own word.
import type { Tone } from "./tokens";

export type StatusIconKind =
  | "check"
  | "half"
  | "diamond"
  | "return"
  | "dashed"
  | "slash"
  | "octagon"
  | "dot";

export interface StatusView {
  readonly status: string;
  readonly label: string;
  /** `null` is the outline look: no tint, a 1px border (`ruled_dead`). */
  readonly tone: Tone | null;
  readonly icon: StatusIconKind;
  /** Cards in this status get the left accent bar. */
  readonly accent: boolean;
  /** The title is struck through. */
  readonly struck: boolean;
}

type Known = Omit<StatusView, "status">;

const KNOWN: Readonly<Record<string, Known>> = {
  critical: { label: "Critical", tone: "error", icon: "octagon", accent: false, struck: false },
  warning: { label: "Warning", tone: "warn", icon: "diamond", accent: false, struck: false },
  info: { label: "Info", tone: "info", icon: "dot", accent: false, struck: false },
  checked: { label: "Checked", tone: "ok", icon: "check", accent: false, struck: false },
  built: {
    label: "Built, needs a check",
    tone: "info",
    icon: "half",
    accent: false,
    struck: false,
  },
  needs_you: { label: "Needs you", tone: "warn", icon: "diamond", accent: true, struck: false },
  blocked: { label: "Blocked", tone: "warn", icon: "octagon", accent: false, struck: false },
  sent_back: { label: "Sent back", tone: "error", icon: "return", accent: true, struck: false },
  planned: { label: "Not built yet", tone: "muted", icon: "dashed", accent: false, struck: false },
  ruled_dead: { label: "Dropped", tone: null, icon: "slash", accent: false, struck: true },
};

/** The legend's order. `blocked` shows only once the relay sends it. */
const STATUS_ORDER: ReadonlyArray<string> = [
  "needs_you",
  "blocked",
  "sent_back",
  "built",
  "checked",
  "planned",
  "ruled_dead",
];

export function humanizeWord(word: string): string {
  const spaced = word.replaceAll("_", " ").trim();
  return spaced === "" ? "Unknown" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The view of one status. `blockedBy` names what a `blocked` item waits on ("Blocked by <item>").
 * An unknown status keeps its own word under a neutral dot.
 */
export function statusView(
  status: string,
  options?: { readonly blockedBy?: string | undefined },
): StatusView {
  const known = KNOWN[status];
  if (known === undefined) {
    return {
      status,
      label: humanizeWord(status),
      tone: "muted",
      icon: "dot",
      accent: false,
      struck: false,
    };
  }
  const blockedBy = options?.blockedBy?.trim();
  const label =
    status === "blocked" && blockedBy !== undefined && blockedBy !== ""
      ? `Blocked by ${blockedBy}`
      : known.label;
  return { status, ...known, label };
}

/**
 * The statuses a legend lists: `statuses` in order, or the known order plus any extra status in
 * `counts`. `blocked` appears only when counted, so it stays hidden until the relay sends it.
 */
export function legendStatuses(
  counts: Readonly<Record<string, number>> | undefined,
  statuses?: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (statuses !== undefined) return statuses;
  const counted = Object.keys(counts ?? {});
  const known = STATUS_ORDER.filter((status) => status !== "blocked" || counted.includes(status));
  return [...known, ...counted.filter((status) => !STATUS_ORDER.includes(status))];
}
