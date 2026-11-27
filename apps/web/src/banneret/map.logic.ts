// Banneret Hub: the build map's shape (relay-v1 "Map and the stage plan"). The relay computes every
// status, reason and counter; these only order and join what it sent.
import type { BanneretMap, BanneretMapItem } from "@t3tools/contracts";

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

/** Statuses that count as built in a stage's progress. */
const BUILT = new Set(["built", "checked"]);

export interface StageProgress {
  /** Items built or checked. */
  readonly built: number;
  /** Every item except dropped ones, which will never be built. */
  readonly total: number;
}

export function stageProgress(counts: Readonly<Record<string, number>>): StageProgress {
  let built = 0;
  let total = 0;
  for (const [status, count] of Object.entries(counts)) {
    if (status === "ruled_dead") continue;
    total += count;
    if (BUILT.has(status)) built += count;
  }
  return { built, total };
}

/** Where a stage sits on the spine. */
export type SpineState = "done" | "ahead" | "current" | "todo";

/**
 * One state per stage, in order. `current` is the first stage not fully built. Every built stage
 * before it is `done`; a built stage after it is `ahead` (built ahead of an earlier stage: it keeps
 * its check but the spine does not fill through it). Anything else is `todo`. A stage with nothing
 * to build is never done, ahead nor current.
 */
export function spineStates(progress: ReadonlyArray<StageProgress>): ReadonlyArray<SpineState> {
  let currentTaken = false;
  return progress.map(({ built, total }) => {
    if (total === 0) return "todo";
    if (built === total) return currentTaken ? "ahead" : "done";
    if (currentTaken) return "todo";
    currentTaken = true;
    return "current";
  });
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

/**
 * What a `blocked` item waits on: its first direct blocker's title (its id when the map lacks that
 * item) and how many more there are; null for any other status or an empty `blockedBy`.
 */
export function blockedByName(map: BanneretMap, item: BanneretMapItem): string | null {
  if (item.status !== "blocked") return null;
  const [first, ...rest] = item.blockedBy;
  if (first === undefined) return null;
  const title = map.items.find((candidate) => candidate.id === first)?.title ?? first;
  return rest.length === 0 ? title : `${title} and ${rest.length} more`;
}

/** "Blocked by <title>" for a `blocked` item (see `blockedByName`); null otherwise. */
export function blockedByLabel(map: BanneretMap, item: BanneretMapItem): string | null {
  const name = blockedByName(map, item);
  return name === null ? null : `Blocked by ${name}`;
}

/** Whether the map holds nothing to draw because its plan could not be used. */
export const mapNotMeasured = (map: BanneretMap) =>
  map.state !== "ok" || map.notMeasured.length > 0;
