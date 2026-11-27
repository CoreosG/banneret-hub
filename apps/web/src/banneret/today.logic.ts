// Banneret Hub: what Today shows for each block. Pure, so the page only draws.
import type { BanneretFeedToday } from "@t3tools/contracts";

import { needsCountLabel } from "./relayFeed.logic";
import type { Tone } from "./ui/tokens";

/**
 * A block's look: its rows, a line saying it is not measured (and why), or a quiet empty line.
 * A block with no rows but a not-measured source is never shown as empty.
 */
export type BlockView = "rows" | "not_measured" | "empty";

export function blockView(block: {
  readonly items: ReadonlyArray<unknown>;
  readonly notMeasured: ReadonlyArray<unknown>;
}): BlockView {
  if (block.items.length > 0) return "rows";
  return block.notMeasured.length > 0 ? "not_measured" : "empty";
}

export interface TodayCounts {
  /** The same figure as the sidebar badge: "4", "4+" or "99+". */
  readonly needs: string;
  readonly stuck: number;
  readonly shipped: number;
  /** "since your last visit" applies only when the relay knows that visit. */
  readonly sinceVisit: boolean;
}

/** What the Needs you count is read from: the relay's own count, else the loaded list. */
export interface NeedsSource {
  readonly needsCount: number | null;
  readonly needs: ReadonlyArray<unknown> | null;
  readonly needsNextCursor: string | null;
}

/**
 * The Needs you figure, matching the sidebar: the relay's count, else the loaded Needs you list,
 * else Today's own block; "+" when more pages wait.
 */
export function needsFigure(feed: NeedsSource, today: BanneretFeedToday | null): string {
  const fromList = feed.needs !== null;
  return (
    needsCountLabel({
      needsCount: feed.needsCount,
      loaded: fromList ? feed.needs!.length : (today?.needsYou.items.length ?? null),
      more: fromList ? feed.needsNextCursor !== null : today?.needsYou.nextCursor != null,
    }) ?? "0"
  );
}

/** The header's counts. */
export function todayCounts(today: BanneretFeedToday, feed: NeedsSource): TodayCounts {
  return {
    needs: needsFigure(feed, today),
    stuck: today.stuck.items.length,
    shipped: today.shipped.items.length,
    sinceVisit: today.lastVisitAt !== null,
  };
}

/** "1 failing · 2 warnings" over the health tiles, or null when nothing is off. */
export function healthSummary(items: ReadonlyArray<{ readonly state: string }>): string | null {
  const failing = items.filter((item) => item.state === "bad").length;
  const warning = items.filter((item) => item.state === "warning").length;
  const parts = [
    failing === 0 ? null : `${failing} failing`,
    warning === 0 ? null : `${warning} ${warning === 1 ? "warning" : "warnings"}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

const WORKING_TONES: Readonly<Record<string, Tone>> = {
  working: "ok",
  waiting: "warn",
  not_heard_from: "warn",
};

/** The dot beside a person at work: green working, amber waiting or not heard from, else neutral. */
export const workingTone = (state: string | undefined): Tone =>
  (state === undefined ? undefined : WORKING_TONES[state]) ?? "muted";

/** The first letter of a login for its avatar; "?" for an empty one. */
export function initial(login: string): string {
  const first = login.trim().charAt(0);
  return first === "" ? "?" : first.toUpperCase();
}
