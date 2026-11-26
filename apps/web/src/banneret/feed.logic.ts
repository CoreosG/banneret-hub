// Banneret Hub: plain words for the feed and graveyard (relay-v1 "Feed and graveyard"). The relay
// derives every entry; these only name, merge and order them. `type` and `importance` are open sets,
// so each has a fallback.
import type {
  BanneretBoardTask,
  BanneretFeedEntry,
  BanneretGraveyardEntry,
} from "@t3tools/contracts";

import { safeLinkOut } from "./relayFeed.logic";

const FEED_TYPES: Readonly<Record<string, string>> = {
  taken: "Taken",
  released: "Released",
  lease_expired: "Lease expired",
  pr_opened: "PR opened",
  pr_merged: "PR merged",
  built: "Built",
  checked: "Checked",
  sent_back: "Sent back",
  ruled_dead: "Ruled dead",
  comment: "Comment",
};

/** The label of a feed entry type; an unknown type shares the generic one. */
export const feedTypeLabel = (type: string) => FEED_TYPES[type] ?? "Activity";

export type Importance = "high" | "normal" | "low";

/** How much an entry stands out. Only styling: entries are never reordered by it. */
export function importanceOf(importance: string): Importance {
  return importance === "high" || importance === "low" ? importance : "normal";
}

const newestFirst = <T>(entries: ReadonlyArray<T>, at: (entry: T) => string): Array<T> => {
  const time = (entry: T) => {
    const ms = Date.parse(at(entry));
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  return entries.toSorted((left, right) => time(right) - time(left));
};

const uniqueBy = <T>(lists: ReadonlyArray<ReadonlyArray<T>>, key: (entry: T) => string) => {
  const seen = new Set<string>();
  const merged: Array<T> = [];
  for (const list of lists) {
    for (const entry of list) {
      const id = key(entry);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(entry);
    }
  }
  return merged;
};

/**
 * The snapshot file's entries and the older pages as one list, newest first. A page can shift when
 * new entries arrive, so the same entry may come twice; the first copy (the snapshot's) wins.
 */
export function mergeFeedEntries(
  ...lists: ReadonlyArray<ReadonlyArray<BanneretFeedEntry>>
): Array<BanneretFeedEntry> {
  return newestFirst(
    uniqueBy(lists, (entry) => entry.id),
    (entry) => entry.at,
  );
}

/** The same for the graveyard, where a task is ruled dead once, so the task id is the key. */
export function mergeGraveyardEntries(
  ...lists: ReadonlyArray<ReadonlyArray<BanneretGraveyardEntry>>
): Array<BanneretGraveyardEntry> {
  return newestFirst(
    uniqueBy(lists, (entry) => entry.task.id),
    (entry) => entry.ruledAt,
  );
}

/**
 * Where a click on a task goes. Every task click on the Feed and Graveyard goes through here: today
 * it is the task's link out on its tracker; the Task tab (Phase 2a slice D) replaces it.
 */
export function openTaskTarget(task: BanneretBoardTask): string | null {
  return safeLinkOut(task.ref.url);
}
