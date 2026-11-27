import type { BanneretMap, BanneretMapItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  COLUMN_CAP,
  arcPath,
  mapViewFromUrl,
  mapViewPatch,
  neighbourhoodLayout,
  neighbourhoodSides,
  ringSegments,
  stageLayout,
} from "./mapGraph.logic";

const item = (
  id: string,
  stageId: string,
  restsOn: string[] = [],
  extra: Partial<BanneretMapItem> = {},
): BanneretMapItem => ({
  id,
  stageId,
  title: id,
  status: "planned",
  statusWhy: "Open.",
  restsOn,
  blockedBy: [],
  ...extra,
});

const mapOf = (items: BanneretMapItem[], stages = [{ id: "s", title: "S", order: 1 }]) =>
  ({
    state: "ok",
    notMeasured: [],
    stages,
    items,
    counters: { byStatus: {}, byStage: {} },
  }) satisfies BanneretMap;

/** A chain a <- b <- c <- d <- e (e rests on d, and so on), plus side branches. */
const CHAIN = mapOf([
  item("a", "s"),
  item("b", "s", ["a"]),
  item("c", "s", ["b"]),
  item("d", "s", ["c"]),
  item("e", "s", ["d"]),
  item("f", "s", ["e"]),
  item("g", "s", ["f"]),
]);

/** Eleven stages, about 80 items, rests-on links between neighbouring stages. */
function bigPlan(): BanneretMap {
  const statuses = ["checked", "built", "needs_you", "blocked", "sent_back", "planned"];
  const stages = Array.from({ length: 11 }, (_, index) => ({
    id: `s${index}`,
    title: `Stage ${index}`,
    order: index,
  }));
  const items: BanneretMapItem[] = [];
  for (let index = 0; index < 80; index += 1) {
    const stage = index % 11;
    items.push(
      item(`i${index}`, `s${stage}`, index > 11 ? [`i${index - 11}`, `i${index - 7}`] : [], {
        status: statuses[(index * 7) % statuses.length]!,
      }),
    );
  }
  const byStage: Record<string, Record<string, number>> = {};
  for (const entry of items) {
    const counts = (byStage[entry.stageId] ??= {});
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return { ...mapOf(items, stages), counters: { byStatus: {}, byStage } };
}

describe("stage bubbles", () => {
  it("lays out the same map the same way every time", () => {
    const first = stageLayout(bigPlan());
    const second = stageLayout(bigPlan());
    expect(second).toEqual(first);
    expect(first.bubbles.map((bubble) => bubble.number)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    );
    // Every bubble fits the canvas and no two overlap.
    for (const bubble of first.bubbles) {
      expect(bubble.x - bubble.r).toBeGreaterThanOrEqual(0);
      expect(bubble.x + bubble.r).toBeLessThanOrEqual(first.width);
      expect(bubble.y + bubble.r).toBeLessThanOrEqual(first.height);
    }
    for (const [i, a] of first.bubbles.entries()) {
      for (const b of first.bubbles.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
      }
    }
    expect(first.spine).toHaveLength(10);
  });

  it("sizes a bubble by its item count and rings it by the relay's counts, dropped left out", () => {
    const map = mapOf(
      [
        item("a", "big", [], { status: "checked" }),
        item("b", "big", [], { status: "built" }),
        item("c", "big", ["x"], { status: "blocked", blockedBy: ["x"] }),
        item("d", "big", [], { status: "ruled_dead" }),
        item("x", "small", [], { status: "needs_you" }),
      ],
      [
        { id: "big", title: "Big", order: 1 },
        { id: "small", title: "Small", order: 2 },
        { id: "none", title: "None", order: 3 },
      ],
    );
    const layout = stageLayout({
      ...map,
      counters: {
        byStatus: {},
        byStage: {
          big: { checked: 1, built: 1, blocked: 1, ruled_dead: 1 },
          small: { needs_you: 1 },
        },
      },
    });
    const [big, small, none] = layout.bubbles;
    expect(big!.r).toBeGreaterThan(small!.r);
    expect(small!.r).toBeGreaterThan(none!.r);
    expect(big!.ring.map((segment) => [segment.status, segment.from, segment.to])).toEqual([
      ["checked", 0, 0.33],
      ["built", 0.33, 0.67],
      ["blocked", 0.67, 1],
    ]);
    expect(big!.dots.map((dot) => dot.itemId)).toEqual(["a", "b", "c", "d"]);
    expect(none!.dots).toEqual([]);
    // One link from Small to Big, and it blocks.
    expect(
      layout.bundles.map((bundle) => [bundle.from, bundle.to, bundle.count, bundle.blocking]),
    ).toEqual([["small", "big", 1, 1]]);
  });

  it("draws a full ring as two arcs", () => {
    expect(ringSegments({ planned: 3 })).toEqual([{ status: "planned", count: 3, from: 0, to: 1 }]);
    expect(arcPath(10, 0, 1).match(/A/g)).toHaveLength(2);
    expect(arcPath(10, 0, 0.25)).toBe("M0,-10 A10,10 0 0 1 10,0");
  });
});

describe("rests-on neighbourhood", () => {
  it("shows two hops each way by default", () => {
    const sides = neighbourhoodSides(CHAIN, "d", []);
    expect([...sides.entries()].toSorted()).toEqual([
      ["b", "up"],
      ["c", "up"],
      ["d", "centre"],
      ["e", "down"],
      ["f", "down"],
    ]);
  });

  it("opens a node one hop further outwards, and closing it hides that hop again", () => {
    const layout = neighbourhoodLayout(CHAIN, "d", []);
    const b = layout.nodes.find((node) => node.id === "b")!;
    const f = layout.nodes.find((node) => node.id === "f")!;
    expect([b.more, b.opened, f.more]).toEqual([1, false, 1]);
    expect(layout.nodes.find((node) => node.id === "c")!.more).toBe(0);

    const opened = neighbourhoodLayout(CHAIN, "d", ["b", "f"]);
    expect(opened.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(opened.nodes.find((node) => node.id === "b")!.opened).toBe(true);
    expect(opened.nodes.find((node) => node.id === "a")!.column).toBe(-3);

    expect(neighbourhoodLayout(CHAIN, "d", ["f"]).nodes.map((node) => node.id)).toEqual([
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
    // Opening a node that is not shown does nothing.
    expect(neighbourhoodLayout(CHAIN, "d", ["a"]).nodes).toHaveLength(5);
  });

  it("puts every blocker left of what rests on it, even a blocker of a blocker", () => {
    // x rests on p and q; p also rests on q. Hop count would put p and q in one column.
    const map = mapOf([
      item("q", "s"),
      item("p", "s", ["q"]),
      item("x", "s", ["p", "q"]),
      item("y", "s", ["x"]),
      item("z", "s", ["x", "y"]),
    ]);
    const layout = neighbourhoodLayout(map, "x", []);
    const column = new Map(layout.nodes.map((node) => [node.id, node.column] as const));
    expect(Object.fromEntries(column)).toEqual({ q: -2, p: -1, x: 0, y: 1, z: 2 });
    for (const edge of layout.edges) {
      expect(column.get(edge.from)!).toBeLessThan(column.get(edge.to)!);
    }
    // Every edge between shown nodes is drawn, not only the ones walked.
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`).toSorted()).toEqual([
      "p>x",
      "q>p",
      "q>x",
      "x>y",
      "x>z",
      "y>z",
    ]);
  });

  it("marks the edges the relay says block: root from the cause, chain from a blocked item", () => {
    const map = mapOf([
      item("root", "s", [], { status: "needs_you" }),
      item("fine", "s", [], { status: "built" }),
      item("mid", "s", ["root", "fine"], { status: "blocked", blockedBy: ["root"] }),
      item("end", "s", ["mid"], { status: "blocked", blockedBy: ["mid"] }),
    ]);
    const edges = neighbourhoodLayout(map, "mid", []).edges;
    expect(
      Object.fromEntries(edges.map((edge) => [`${edge.from}>${edge.to}`, edge.blocking])),
    ).toEqual({
      "root>mid": "root",
      "fine>mid": null,
      "mid>end": "chain",
    });
  });

  it("is deterministic, caps long columns with blockers first, and shows all on request", () => {
    const leaves = Array.from({ length: 20 }, (_, index) =>
      item(`l${String(index).padStart(2, "0")}`, "s", ["hub"], {
        status: index === 17 ? "blocked" : "planned",
        blockedBy: index === 17 ? ["hub"] : [],
      }),
    );
    const map = mapOf([item("hub", "s", [], { status: "needs_you" }), ...leaves]);
    const capped = neighbourhoodLayout(map, "hub", []);
    expect(neighbourhoodLayout(map, "hub", [])).toEqual(capped);
    expect(capped.nodes.filter((node) => node.column === 1)).toHaveLength(COLUMN_CAP);
    expect(capped.nodes.some((node) => node.id === "l17")).toBe(true);
    expect(capped.hidden).toEqual([{ column: 1, count: 20 - COLUMN_CAP }]);
    const all = neighbourhoodLayout(map, "hub", [], { showAll: true });
    expect(all.nodes).toHaveLength(21);
    expect(all.hidden).toEqual(capped.hidden);
  });

  it("lays out every item of a large plan the same on every run", () => {
    const map = bigPlan();
    const layouts = map.items.map((entry) => neighbourhoodLayout(map, entry.id, []));
    expect(map.items.map((entry) => neighbourhoodLayout(map, entry.id, []))).toEqual(layouts);
  });

  it("survives a cycle and ids the map lacks", () => {
    const map = mapOf([item("a", "s", ["b", "ghost"]), item("b", "s", ["a"])]);
    const layout = neighbourhoodLayout(map, "a", []);
    expect(layout.nodes.map((node) => node.id).toSorted()).toEqual(["a", "b"]);
    expect(neighbourhoodLayout(map, "missing", []).nodes).toEqual([]);
  });
});

describe("map view URL state", () => {
  it("reads and writes the view, stage, item, opened nodes and show all", () => {
    expect(mapViewFromUrl({})).toEqual({
      view: "list",
      stage: null,
      item: null,
      open: [],
      all: false,
    });
    expect(
      mapViewFromUrl({ view: "neighbourhood", item: "x", open: "a,b,a", all: "1", stage: "s" }),
    ).toEqual({ view: "neighbourhood", stage: "s", item: "x", open: ["a", "b"], all: true });
    expect(mapViewFromUrl({ view: "nonsense" }).view).toBe("list");
    expect(mapViewPatch({ view: "list", item: null, open: [], all: false })).toEqual({
      view: undefined,
      item: undefined,
      open: undefined,
      all: undefined,
    });
    expect(mapViewPatch({ view: "stages", stage: "s2" })).toEqual({ view: "stages", stage: "s2" });
    expect(mapViewPatch({ open: ["a", "b"] })).toEqual({ open: "a,b" });
  });
});
