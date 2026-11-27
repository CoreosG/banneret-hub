import type { BanneretMap, BanneretMapItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { blockedByLabel, mapStages, restsOnView, spineStates, stageProgress } from "./map.logic";

const item = (id: string, stageId: string, restsOn: string[] = []): BanneretMapItem => ({
  id,
  stageId,
  title: id,
  status: "planned",
  statusWhy: "Open.",
  restsOn,
  blockedBy: [],
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

  it("counts built and checked out of every item that is not dropped", () => {
    expect(stageProgress({ built: 1, checked: 2, planned: 1, ruled_dead: 1 })).toEqual({
      built: 3,
      total: 4,
    });
    expect(stageProgress({ ruled_dead: 2 })).toEqual({ built: 0, total: 0 });
    expect(stageProgress({})).toEqual({ built: 0, total: 0 });
  });

  it("marks done stages, the first unfinished one as current, and the rest not started", () => {
    const p = (built: number, total: number) => ({ built, total });
    expect(spineStates([p(1, 1), p(0, 0), p(3, 3), p(1, 2), p(0, 1), p(2, 2)])).toEqual([
      "done",
      "todo",
      "done",
      "current",
      "todo",
      "done",
    ]);
    expect(spineStates([p(0, 0), p(0, 2)])).toEqual(["todo", "current"]);
  });

  it("names a blocked item's first direct blocker, by title, else by id", () => {
    const blocked = (blockedBy: string[], status = "blocked") => ({
      ...item("x", "first"),
      status,
      blockedBy,
    });
    expect(blockedByLabel(MAP, blocked(["a"]))).toBe("Blocked by a");
    expect(blockedByLabel(MAP, blocked(["a", "b", "ghost"]))).toBe("Blocked by a and 2 more");
    expect(blockedByLabel(MAP, blocked(["ghost"]))).toBe("Blocked by ghost");
    expect(blockedByLabel(MAP, blocked([]))).toBeNull();
    // Only a blocked item says so; a higher status keeps its own words.
    expect(blockedByLabel(MAP, blocked(["a"], "checked"))).toBeNull();
  });
});
