import type { BanneretMap, BanneretMapItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mapStages, orderedCounts, restsOnView } from "./map.logic";

const item = (id: string, stageId: string, restsOn: string[] = []): BanneretMapItem => ({
  id,
  stageId,
  title: id,
  status: "planned",
  statusWhy: "Open.",
  restsOn,
});

const MAP: BanneretMap = {
  state: "ok",
  notMeasured: [],
  stages: [
    { id: "late", title: "Late", order: 30 },
    { id: "first", title: "First", order: 10 },
    { id: "tie", title: "Tie", order: 10 },
  ],
  items: [
    item("a", "first"),
    item("b", "late", ["a", "ghost"]),
    item("c", "nowhere", ["a"]),
    item("d", "tie", ["b", "b"]),
  ],
  counters: { byStatus: { planned: 4 }, byStage: { first: { planned: 1 } } },
};

describe("map shape", () => {
  it("orders stages by order, keeps ties in relay order, and puts unknown stages last", () => {
    const stages = mapStages(MAP);
    expect(stages.map((stage) => stage.title)).toEqual(["First", "Tie", "Late", "Other"]);
    expect(stages[0]!.items.map((entry) => entry.id)).toEqual(["a"]);
    expect(stages[0]!.counts).toEqual({ planned: 1 });
    expect(stages[1]!.counts).toEqual({});
    expect(stages[3]!.items.map((entry) => entry.id)).toEqual(["c"]);
    expect(stages[3]!.counts).toEqual({ planned: 1 });
  });

  it("lists both directions of rests-on, keeping an unknown id as a bare entry", () => {
    const b = restsOnView(MAP, "b");
    expect(b.restsOn.map((entry) => [entry.id, entry.item?.id ?? null])).toEqual([
      ["a", "a"],
      ["ghost", null],
    ]);
    expect(b.dependants.map((entry) => entry.id)).toEqual(["d"]);
    expect(restsOnView(MAP, "a").dependants.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(restsOnView(MAP, "d").restsOn.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("orders counts by the vocabulary and drops zeros", () => {
    expect(orderedCounts({ planned: 2, mystery: 1, ruled_dead: 1, built: 0 })).toEqual([
      { status: "ruled_dead", count: 1 },
      { status: "planned", count: 2 },
      { status: "mystery", count: 1 },
    ]);
  });
});
