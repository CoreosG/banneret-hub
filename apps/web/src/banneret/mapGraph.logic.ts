// Banneret Hub: the Map's two graph views, laid out in plain code so the same map always gives the same
// picture. Stages are bubbles in plan order; the neighbourhood is a layered graph of what an item rests
// on (left) and what rests on it (right). Every status and every `blockedBy` comes from the relay.
import type { BanneretMap, BanneretMapItem } from "@t3tools/contracts";

import { mapStages, spineStates, stageProgress, type SpineState } from "./map.logic";

/** The order statuses take in a bubble's ring and dots: finished work first, dropped work last. */
const FILL_ORDER: ReadonlyArray<string> = [
  "checked",
  "built",
  "sent_back",
  "needs_you",
  "blocked",
  "planned",
];

const fillRank = (status: string) => {
  if (status === "ruled_dead") return FILL_ORDER.length + 1;
  const rank = FILL_ORDER.indexOf(status);
  return rank === -1 ? FILL_ORDER.length : rank;
};

const round = (value: number) => Math.round(value * 100) / 100;

export interface RingSegment {
  readonly status: string;
  readonly count: number;
  /** Where the segment starts and ends, as fractions of the full circle from 12 o'clock. */
  readonly from: number;
  readonly to: number;
}

/** A bubble's ring: one segment per status, sized by the relay's counts. Dropped items are left out. */
export function ringSegments(counts: Readonly<Record<string, number>>): ReadonlyArray<RingSegment> {
  const entries = Object.entries(counts)
    .filter(([status, count]) => status !== "ruled_dead" && count > 0)
    .toSorted(([a], [b]) => fillRank(a) - fillRank(b) || a.localeCompare(b));
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  let at = 0;
  return entries.map(([status, count]) => {
    const from = at;
    at += count / total;
    return { status, count, from: round(from), to: round(at) };
  });
}

export interface BubbleDot {
  readonly itemId: string;
  readonly status: string;
  readonly x: number;
  readonly y: number;
}

export interface StageBubble {
  readonly id: string;
  readonly title: string;
  /** The stage's place in plan order, from 1. */
  readonly number: number;
  readonly count: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly built: number;
  readonly total: number;
  readonly spine: SpineState;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly ring: ReadonlyArray<RingSegment>;
  readonly dots: ReadonlyArray<BubbleDot>;
  readonly dotRadius: number;
}

export interface StageBundle {
  /** The stage holding the blockers. */
  readonly from: string;
  /** The stage holding the items that rest on them. */
  readonly to: string;
  readonly count: number;
  /** How many of those links block right now. */
  readonly blocking: number;
  readonly path: string;
}

export interface StageLayout {
  readonly width: number;
  readonly height: number;
  readonly bubbles: ReadonlyArray<StageBubble>;
  /** The plan order, one path from each stage to the next. */
  readonly spine: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly path: string;
  }>;
  readonly bundles: ReadonlyArray<StageBundle>;
}

const STAGE_VIEW_WIDTH = 1000;
const STAGE_PAD = 24;
const STAGE_GAP = 40;
/** Room under a bubble for its title and count. */
const STAGE_LABEL = 44;
const ROW_GAP = 28;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const bubbleRadius = (count: number) =>
  count === 0 ? 26 : Math.min(96, Math.round(32 + 8 * Math.sqrt(count)));

/** Items as dots on a sunflower spiral, grouped by status from the centre out. */
function bubbleDots(
  items: ReadonlyArray<BanneretMapItem>,
  r: number,
): { readonly dots: ReadonlyArray<BubbleDot>; readonly dotRadius: number } {
  const sorted = items
    .map((item, position) => ({ item, position }))
    .toSorted(
      (a, b) => fillRank(a.item.status) - fillRank(b.item.status) || a.position - b.position,
    );
  const inner = r - 14;
  const n = sorted.length;
  const dotRadius = n === 0 ? 0 : round(Math.max(1.6, Math.min(5, (inner / Math.sqrt(n)) * 0.55)));
  const dots = sorted.map(({ item }, k) => {
    const distance = inner * Math.sqrt((k + 0.5) / n);
    const angle = k * GOLDEN_ANGLE;
    return {
      itemId: item.id,
      status: item.status,
      x: round(Math.cos(angle) * distance),
      y: round(Math.sin(angle) * distance),
    };
  });
  return { dots, dotRadius };
}

const curve = (ax: number, ay: number, bx: number, by: number, bend: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  return `M${round(ax)},${round(ay)} Q${round((ax + bx) / 2 - dy * bend)},${round((ay + by) / 2 + dx * bend)} ${round(bx)},${round(by)}`;
};

/**
 * Stages as bubbles in plan order. Rows run left to right, then right to left, so each stage sits
 * beside the next. A bubble's area grows with its item count.
 */
export function stageLayout(map: BanneretMap): StageLayout {
  const stages = mapStages(map);
  const progress = stages.map((stage) => stageProgress(stage.counts));
  const spine = spineStates(progress);
  const sized = stages.map((stage, index) => ({
    stage,
    index,
    r: bubbleRadius(stage.items.length),
  }));

  const rows: Array<Array<(typeof sized)[number]>> = [];
  let row: Array<(typeof sized)[number]> = [];
  let used = 0;
  const room = STAGE_VIEW_WIDTH - 2 * STAGE_PAD;
  for (const entry of sized) {
    const slot = Math.max(2 * entry.r, 132);
    if (row.length > 0 && used + STAGE_GAP + slot > room) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length === 0 ? 0 : STAGE_GAP) + slot;
    row.push(entry);
  }
  if (row.length > 0) rows.push(row);

  const bubbles: StageBubble[] = [];
  let top = STAGE_PAD;
  rows.forEach((entries, rowIndex) => {
    const slots = entries.map((entry) => Math.max(2 * entry.r, 132));
    const width = slots.reduce((sum, slot) => sum + slot, 0) + STAGE_GAP * (entries.length - 1);
    const tallest = Math.max(...entries.map((entry) => entry.r));
    const wave = entries.length > 1 ? 12 : 0;
    let left = (STAGE_VIEW_WIDTH - width) / 2;
    const placed = entries.map((entry, column) => {
      const slot = slots[column]!;
      const x = left + slot / 2;
      left += slot + STAGE_GAP;
      return { entry, x };
    });
    if (rowIndex % 2 === 1) {
      const xs = placed.map((place) => place.x).toReversed();
      placed.forEach((place, column) => {
        place.x = xs[column]!;
      });
    }
    for (const [column, { entry, x }] of placed.entries()) {
      const { stage, index, r } = entry;
      const y = top + wave + tallest + (column % 2 === 0 ? -wave : wave);
      const { built, total } = progress[index]!;
      bubbles.push({
        id: stage.id,
        title: stage.title,
        number: index + 1,
        count: stage.items.length,
        counts: stage.counts,
        built,
        total,
        spine: spine[index]!,
        x: round(x),
        y: round(y),
        r,
        ring: ringSegments(stage.counts),
        ...bubbleDots(stage.items, r),
      });
    }
    top += 2 * tallest + 2 * wave + STAGE_LABEL + ROW_GAP;
  });

  const spinePaths = bubbles.slice(1).map((bubble, index) => {
    const previous = bubbles[index]!;
    return {
      from: previous.id,
      to: bubble.id,
      path: curve(previous.x, previous.y, bubble.x, bubble.y, 0),
    };
  });

  const position = new Map(bubbles.map((bubble) => [bubble.id, bubble] as const));
  const stageOf = new Map(map.items.map((item) => [item.id, item.stageId] as const));
  const known = new Set(map.stages.map((stage) => stage.id));
  const stageKey = (id: string) => {
    const stage = stageOf.get(id);
    return stage === undefined ? undefined : known.has(stage) ? stage : "";
  };
  const tally = new Map<string, { from: string; to: string; count: number; blocking: number }>();
  for (const item of map.items) {
    const to = stageKey(item.id);
    for (const blocker of new Set(item.restsOn)) {
      const from = stageKey(blocker);
      if (from === undefined || to === undefined || from === to) continue;
      const key = `${from}\n${to}`;
      const entry = tally.get(key) ?? { from, to, count: 0, blocking: 0 };
      entry.count += 1;
      if (item.blockedBy.includes(blocker)) entry.blocking += 1;
      tally.set(key, entry);
    }
  }
  const order = new Map(bubbles.map((bubble, index) => [bubble.id, index] as const));
  const bundles = [...tally.values()]
    .filter((entry) => position.has(entry.from) && position.has(entry.to))
    .toSorted(
      (a, b) => order.get(a.from)! - order.get(b.from)! || order.get(a.to)! - order.get(b.to)!,
    )
    .map((entry) => {
      const a = position.get(entry.from)!;
      const b = position.get(entry.to)!;
      return { ...entry, path: curve(a.x, a.y, b.x, b.y, 0.18) };
    });

  return {
    width: STAGE_VIEW_WIDTH,
    height: Math.round(top - ROW_GAP + STAGE_PAD),
    bubbles,
    spine: spinePaths,
    bundles,
  };
}

/** The ring segment as an SVG arc around (0, 0). A full circle is drawn as two halves. */
export function arcPath(r: number, from: number, to: number): string {
  const point = (fraction: number) => {
    const angle = fraction * 2 * Math.PI - Math.PI / 2;
    return `${round(Math.cos(angle) * r)},${round(Math.sin(angle) * r)}`;
  };
  if (to - from >= 0.9999) {
    return `M${point(0)} A${r},${r} 0 1 1 ${point(0.5)} A${r},${r} 0 1 1 ${point(0)}`;
  }
  const large = to - from > 0.5 ? 1 : 0;
  return `M${point(from)} A${r},${r} 0 ${large} 1 ${point(to)}`;
}

// The neighbourhood graph.

/** Hops shown each way before any node is opened. */
const DEFAULT_HOPS = 2;
/** Nodes shown per column before "Show all". */
export const COLUMN_CAP = 12;

const NODE_WIDTH = 168;
export const NODE_HEIGHT = 44;
const COLUMN_GAP = 48;
const ROW_PITCH = 56;
const GRAPH_PAD = 16;

export type NodeSide = "up" | "centre" | "down";

export interface GraphNode {
  readonly id: string;
  readonly item: BanneretMapItem;
  readonly side: NodeSide;
  /** Negative left of the centre (what it rests on), positive right (what rests on it). */
  readonly column: number;
  readonly x: number;
  readonly y: number;
  /** Neighbours further out on its side that are not shown yet. */
  readonly more: number;
  /** Opened by the person: its next hop outwards is shown. */
  readonly opened: boolean;
}

/** `root`: the blocker itself needs you, was sent back or was dropped. `chain`: the blocker is blocked. */
export type EdgeBlocking = "root" | "chain";

export interface GraphEdge {
  /** The blocker. */
  readonly from: string;
  /** The item that rests on it. */
  readonly to: string;
  readonly blocking: EdgeBlocking | null;
  readonly path: string;
}

export interface NeighbourhoodLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<GraphEdge>;
  /** Columns longer than `COLUMN_CAP` and how many nodes past the cap they hold; left out unless `showAll`. */
  readonly hidden: ReadonlyArray<{ readonly column: number; readonly count: number }>;
}

interface Index {
  readonly byId: ReadonlyMap<string, BanneretMapItem>;
  readonly position: ReadonlyMap<string, number>;
  /** Item id to the ids it rests on, known items only, without repeats. */
  readonly up: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Item id to the ids that rest on it, in map order. */
  readonly down: ReadonlyMap<string, ReadonlyArray<string>>;
}

function indexMap(map: BanneretMap): Index {
  const byId = new Map(map.items.map((item) => [item.id, item] as const));
  const position = new Map(map.items.map((item, index) => [item.id, index] as const));
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const item of map.items) {
    const blockers = [...new Set(item.restsOn)].filter((id) => byId.has(id) && id !== item.id);
    up.set(item.id, blockers);
    for (const blocker of blockers) {
      const list = down.get(blocker) ?? [];
      list.push(item.id);
      down.set(blocker, list);
    }
  }
  return { byId, position, up, down };
}

/**
 * Which items the neighbourhood shows, and on which side: `hops` steps up and down from the centre,
 * plus one more step outwards from every opened node. An item reached both ways (only a broken plan
 * has such a cycle) stays on the side found first.
 */
export function neighbourhoodSides(
  map: BanneretMap,
  centreId: string,
  opened: ReadonlyArray<string>,
  hops: number = DEFAULT_HOPS,
): ReadonlyMap<string, NodeSide> {
  const index = indexMap(map);
  const sides = new Map<string, NodeSide>();
  if (!index.byId.has(centreId)) return sides;
  sides.set(centreId, "centre");
  for (const side of ["up", "down"] as const) {
    const next = side === "up" ? index.up : index.down;
    let frontier = [centreId];
    for (let hop = 0; hop < hops && frontier.length > 0; hop += 1) {
      const found: string[] = [];
      for (const id of frontier) {
        for (const neighbour of next.get(id) ?? []) {
          if (sides.has(neighbour)) continue;
          sides.set(neighbour, side);
          found.push(neighbour);
        }
      }
      frontier = found;
    }
  }
  // Opening a node shows its next hop outwards; that may reach another opened node.
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of opened) {
      const side = sides.get(id);
      if (side !== "up" && side !== "down") continue;
      const next = side === "up" ? index.up : index.down;
      for (const neighbour of next.get(id) ?? []) {
        if (sides.has(neighbour)) continue;
        sides.set(neighbour, side);
        grew = true;
      }
    }
  }
  return sides;
}

/** Longest path, in steps, from `id` to the centre along shown edges (up) or from the centre (down). */
function depths(
  sides: ReadonlyMap<string, NodeSide>,
  index: Index,
  centreId: string,
): ReadonlyMap<string, number> {
  const depth = new Map<string, number>([[centreId, 0]]);
  const visiting = new Set<string>();
  const measure = (id: string, side: "up" | "down"): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 1;
    visiting.add(id);
    // An up node sits one column left of the furthest-left shown thing that rests on it.
    const toward = (side === "up" ? index.down : index.up).get(id) ?? [];
    let best = 0;
    for (const neighbour of toward) {
      const neighbourSide = sides.get(neighbour);
      if (neighbourSide !== side && neighbourSide !== "centre") continue;
      best = Math.max(best, measure(neighbour, side) + 1);
    }
    visiting.delete(id);
    const value = Math.max(1, best);
    depth.set(id, value);
    return value;
  };
  for (const [id, side] of sides) if (side !== "centre") measure(id, side);
  return depth;
}

/**
 * A blocker's arrow into what rests on it. An arrow that skips columns arcs over them, peaking at
 * `peak`, so it never runs behind a node.
 */
const edgePath = (
  from: { x: number; y: number },
  to: { x: number; y: number },
  peak: number | null,
) => {
  const ax = from.x + NODE_WIDTH;
  const ay = from.y + NODE_HEIGHT / 2;
  const bx = to.x;
  const by = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(24, (bx - ax) / 2);
  if (peak === null) {
    return `M${round(ax)},${round(ay)} C${round(ax + bend)},${round(ay)} ${round(bx - bend)},${round(by)} ${round(bx)},${round(by)}`;
  }
  // A cubic whose two control points share y reaches (ay + by) / 8 + 0.75 * y at its middle.
  const control = (peak - (ay + by) / 8) / 0.75;
  return `M${round(ax)},${round(ay)} C${round(ax + bend / 2)},${round(control)} ${round(bx - bend / 2)},${round(control)} ${round(bx)},${round(by)}`;
};

/**
 * The neighbourhood as columns: blockers to the left, dependants to the right, every edge pointing
 * from a blocker to what rests on it. A node's column is its longest path to the centre, so an edge
 * never runs inside one column. Rows follow the neighbours' average row, ties by map order.
 */
export function neighbourhoodLayout(
  map: BanneretMap,
  centreId: string,
  opened: ReadonlyArray<string>,
  options: { readonly hops?: number; readonly showAll?: boolean } = {},
): NeighbourhoodLayout {
  const index = indexMap(map);
  const sides = neighbourhoodSides(map, centreId, opened, options.hops ?? DEFAULT_HOPS);
  if (sides.size === 0) return { width: 0, height: 0, nodes: [], edges: [], hidden: [] };
  const depth = depths(sides, index, centreId);
  const columnOf = (id: string) => {
    const side = sides.get(id)!;
    return side === "centre" ? 0 : side === "up" ? -depth.get(id)! : depth.get(id)!;
  };
  const byPosition = (a: string, b: string) => index.position.get(a)! - index.position.get(b)!;

  const columns = new Map<number, string[]>();
  for (const id of [...sides.keys()].toSorted(byPosition)) {
    const column = columnOf(id);
    const list = columns.get(column) ?? [];
    list.push(id);
    columns.set(column, list);
  }
  const blocksShown = (id: string) => {
    const item = index.byId.get(id)!;
    if (item.blockedBy.some((blocker) => sides.has(blocker))) return true;
    return (index.down.get(id) ?? []).some(
      (dependant) => sides.has(dependant) && index.byId.get(dependant)!.blockedBy.includes(id),
    );
  };
  const hidden: Array<{ column: number; count: number }> = [];
  const shown = new Set<string>();
  for (const [column, ids] of columns) {
    let kept = ids;
    if (ids.length > COLUMN_CAP) {
      hidden.push({ column, count: ids.length - COLUMN_CAP });
      if (options.showAll !== true) {
        kept = ids
          .toSorted((a, b) => Number(blocksShown(b)) - Number(blocksShown(a)) || byPosition(a, b))
          .slice(0, COLUMN_CAP)
          .toSorted(byPosition);
      }
    }
    columns.set(column, kept);
    for (const id of kept) shown.add(id);
  }

  const order = [...columns.keys()].toSorted((a, b) => a - b);
  const neighboursOf = (id: string) =>
    [...(index.up.get(id) ?? []), ...(index.down.get(id) ?? [])].filter((other) =>
      shown.has(other),
    );
  const rowOf = new Map<string, number>();
  const settle = (column: number) =>
    columns.get(column)!.forEach((id, row) => {
      rowOf.set(id, row);
    });
  for (const column of order) settle(column);
  const sweep = (sequence: ReadonlyArray<number>, previous: (column: number) => number) => {
    for (const column of sequence) {
      const near = previous(column);
      const ids = columns.get(column)!;
      const centreOf = (id: string) => {
        const rows = neighboursOf(id)
          .filter((other) => columnOf(other) === near)
          .map((other) => rowOf.get(other)!);
        return rows.length === 0
          ? rowOf.get(id)!
          : rows.reduce((sum, value) => sum + value, 0) / rows.length;
      };
      columns.set(
        column,
        ids.toSorted((a, b) => centreOf(a) - centreOf(b) || byPosition(a, b)),
      );
      settle(column);
    }
  };
  // Outwards from the centre on each side, twice.
  const left = order.filter((column) => column < 0).toReversed();
  const right = order.filter((column) => column > 0);
  for (let pass = 0; pass < 2; pass += 1) {
    sweep(left, (column) => column + 1);
    sweep(right, (column) => column - 1);
  }

  const tallest = Math.max(...order.map((column) => columns.get(column)!.length));
  const first = order[0]!;
  const place = new Map<string, { x: number; y: number }>();
  const columnHeight = (tallest - 1) * ROW_PITCH + NODE_HEIGHT;
  for (const column of order) {
    const ids = columns.get(column)!;
    const offset = (columnHeight - (ids.length - 1) * ROW_PITCH - NODE_HEIGHT) / 2;
    ids.forEach((id, row) => {
      place.set(id, {
        x: GRAPH_PAD + (column - first) * (NODE_WIDTH + COLUMN_GAP),
        y: offset + row * ROW_PITCH,
      });
    });
  }
  const links = order.flatMap((column) =>
    columns.get(column)!.flatMap((id) => {
      const item = index.byId.get(id)!;
      return (index.up.get(id) ?? [])
        .filter((blocker) => shown.has(blocker))
        .map((blocker) => {
          const between = order.filter((other) => other > columnOf(blocker) && other < column);
          const tops = between.map((other) => place.get(columns.get(other)![0]!)!.y);
          return {
            from: blocker,
            to: id,
            blocking: item.blockedBy.includes(blocker)
              ? index.byId.get(blocker)!.status === "blocked"
                ? ("chain" as const)
                : ("root" as const)
              : null,
            peak: tops.length === 0 ? null : Math.min(...tops) - 10,
          };
        });
    }),
  );
  // Room above the tallest column for arrows that arc over it.
  const lift = Math.max(0, ...links.map((link) => (link.peak === null ? 0 : -link.peak + 4)));
  const top = GRAPH_PAD + lift;
  for (const spot of place.values()) spot.y = round(spot.y + top);
  const height = top + columnHeight + GRAPH_PAD;
  const open = new Set(opened);
  const nodes: GraphNode[] = order.flatMap((column) =>
    columns.get(column)!.map((id) => {
      const side = sides.get(id)!;
      const outward = side === "up" ? index.up.get(id) : side === "down" ? index.down.get(id) : [];
      return {
        id,
        item: index.byId.get(id)!,
        side,
        column,
        ...place.get(id)!,
        more: (outward ?? []).filter((other) => !sides.has(other)).length,
        opened: side !== "centre" && open.has(id),
      };
    }),
  );
  const edges: GraphEdge[] = links.map((link) => ({
    from: link.from,
    to: link.to,
    blocking: link.blocking,
    path: edgePath(
      place.get(link.from)!,
      place.get(link.to)!,
      link.peak === null ? null : link.peak + top,
    ),
  }));
  const last = order.at(-1)!;
  return {
    width: GRAPH_PAD * 2 + (last - first + 1) * NODE_WIDTH + (last - first) * COLUMN_GAP,
    height,
    nodes,
    edges,
    hidden: hidden.toSorted((a, b) => a.column - b.column),
  };
}

// The URL state of the Map's views.

export type MapView = "list" | "stages" | "neighbourhood";

export interface MapViewState {
  readonly view: MapView;
  /** The expanded stage in the Stages view. */
  readonly stage: string | null;
  /** The neighbourhood's centre item. */
  readonly item: string | null;
  /** Nodes opened one hop further. */
  readonly open: ReadonlyArray<string>;
  /** Every column shown in full. */
  readonly all: boolean;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

export function mapViewFromUrl(search: Readonly<Record<string, unknown>>): MapViewState {
  const view = search.view === "stages" || search.view === "neighbourhood" ? search.view : "list";
  const open = text(search.open);
  return {
    view,
    stage: text(search.stage),
    item: text(search.item),
    open: open === null ? [] : [...new Set(open.split(",").filter((id) => id !== ""))],
    all: search.all === "1" || search.all === 1 || search.all === true,
  };
}

/** The URL patch for a view state; list is the default and leaves no `view`. */
export function mapViewPatch(
  state: Partial<MapViewState>,
): Readonly<Record<string, string | undefined>> {
  const patch: Record<string, string | undefined> = {};
  if (state.view !== undefined) patch.view = state.view === "list" ? undefined : state.view;
  if ("stage" in state) patch.stage = state.stage ?? undefined;
  if ("item" in state) patch.item = state.item ?? undefined;
  if (state.open !== undefined)
    patch.open = state.open.length === 0 ? undefined : state.open.join(",");
  if (state.all !== undefined) patch.all = state.all ? "1" : undefined;
  return patch;
}

/** The search a link to one item's neighbourhood carries. */
export const neighbourhoodSearch = (itemId: string) => ({ view: "neighbourhood", item: itemId });

/** The item a task id resolves to on the map, if any. */
export const mapItemForTask = (map: BanneretMap | null, taskId: string) =>
  map?.items.find((item) => item.task?.id === taskId) ?? null;
