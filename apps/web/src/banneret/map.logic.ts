// Banneret Hub: the build map's shape (relay-v1 "Map and the stage plan"). The relay computes every
// status, reason and counter; these only order and join what it sent.
import type { BanneretMap, BanneretMapItem } from "@t3tools/contracts";

import { STATUS_VOCABULARY } from "./board.logic";

export interface MapStageView {
  readonly id: string;
  readonly title: string;
  readonly items: ReadonlyArray<BanneretMapItem>;
  /** The relay's counts for this stage, `{<status>: n}`. */
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Stages in ascending `order` (ties keep the relay's order), each with its items in the relay's
 * order. An item naming an unknown stage goes to a trailing "Other".
 */
export function mapStages(map: BanneretMap): ReadonlyArray<MapStageView> {
  const stages = map.stages
    .map((stage, position) => ({ stage, position }))
    .toSorted((a, b) => a.stage.order - b.stage.order || a.position - b.position)
    .map(({ stage }) => ({
      id: stage.id,
      title: stage.title,
      items: map.items.filter((item) => item.stageId === stage.id),
      counts: map.counters.byStage[stage.id] ?? {},
    }));
  const known = new Set(map.stages.map((stage) => stage.id));
  const other = map.items.filter((item) => !known.has(item.stageId));
  return other.length === 0
    ? stages
    : [...stages, { id: "", title: "Other", items: other, counts: countByStatus(other) }];
}

function countByStatus(items: ReadonlyArray<BanneretMapItem>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

/** Non-zero counts, known statuses in the vocabulary's order, then unknown ones by name. */
export function orderedCounts(
  counts: Readonly<Record<string, number>>,
): ReadonlyArray<{ readonly status: string; readonly count: number }> {
  const known = STATUS_VOCABULARY.map((entry) => entry.status);
  const rank = (status: string) => {
    const index = known.indexOf(status);
    return index === -1 ? known.length : index;
  };
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .toSorted(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([status, count]) => ({ status, count }));
}

/** An item on one side of a rests-on link; `item` is null when the plan names an id the map lacks. */
export interface RestsOnEntry {
  readonly id: string;
  readonly item: BanneretMapItem | null;
}

export interface RestsOnView {
  /** What the item rests on, in its `restsOn` order. */
  readonly restsOn: ReadonlyArray<RestsOnEntry>;
  /** What rests on the item, in map order. */
  readonly dependants: ReadonlyArray<BanneretMapItem>;
}

export function restsOnView(map: BanneretMap, itemId: string): RestsOnView {
  const byId = new Map(map.items.map((item) => [item.id, item] as const));
  const item = byId.get(itemId);
  return {
    restsOn: [...new Set(item?.restsOn ?? [])].map((id) => ({ id, item: byId.get(id) ?? null })),
    dependants: map.items.filter(
      (candidate) => candidate.id !== itemId && candidate.restsOn.includes(itemId),
    ),
  };
}

/** Whether the map holds nothing to draw because its plan could not be used. */
export const mapNotMeasured = (map: BanneretMap) =>
  map.state !== "ok" || map.notMeasured.length > 0;
