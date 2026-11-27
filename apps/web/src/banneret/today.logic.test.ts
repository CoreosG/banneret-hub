import type { BanneretFeedToday } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  blockView,
  healthSummary,
  initial,
  needsFigure,
  todayCounts,
  workingTone,
} from "./today.logic";

const block = { state: "ok", items: [], notMeasured: [] };
const nm = { source: "work_tracker", reason: "not_configured", since: "2026-11-26T08:00:00.000Z" };

describe("today blocks", () => {
  it("shows rows, else says a block is not measured, and only then calls it empty", () => {
    expect(blockView({ items: [1], notMeasured: [nm] })).toBe("rows");
    expect(blockView({ items: [], notMeasured: [nm] })).toBe("not_measured");
    expect(blockView({ items: [], notMeasured: [] })).toBe("empty");
  });

  it("counts needs as the sidebar does, and says since the last visit only when it is known", () => {
    const today: BanneretFeedToday = {
      generatedAt: "2026-11-26T10:00:00.000Z",
      lastVisitAt: null,
      needsYou: {
        ...block,
        items: [{ id: "n1", kind: "mention", title: "t", createdAt: "x" }],
        nextCursor: "c1",
      },
      shipped: block,
      working: block,
      stuck: block,
      health: block,
    };
    const none = { needsCount: null, needs: null, needsNextCursor: null };
    // The relay's own count wins.
    expect(todayCounts(today, { ...none, needsCount: 7 })).toEqual({
      needs: "7",
      stuck: 0,
      shipped: 0,
      sinceVisit: false,
    });
    // The loaded Needs you list comes next, with "+" while more pages wait.
    expect(needsFigure({ ...none, needs: [1, 2, 3, 4], needsNextCursor: "c2" }, today)).toBe("4+");
    expect(needsFigure({ ...none, needs: [1, 2, 3, 4] }, today)).toBe("4");
    // Else Today's own block, which may be cut short too.
    expect(todayCounts({ ...today, lastVisitAt: "2026-11-25T10:00:00.000Z" }, none)).toEqual({
      needs: "1+",
      stuck: 0,
      shipped: 0,
      sinceVisit: true,
    });
    expect(needsFigure(none, null)).toBe("0");
  });

  it("sums failing and warning health, and nothing when all is well", () => {
    expect(healthSummary([{ state: "bad" }, { state: "warning" }, { state: "warning" }])).toBe(
      "1 failing · 2 warnings",
    );
    expect(healthSummary([{ state: "good" }, { state: "not_measured" }])).toBeNull();
  });

  it("tones a person's dot by state and draws an initial for any login", () => {
    expect(workingTone("working")).toBe("ok");
    expect(workingTone("waiting")).toBe("warn");
    expect(workingTone("brand_new")).toBe("muted");
    expect(workingTone(undefined)).toBe("muted");
    expect(initial("mira-dev")).toBe("M");
    expect(initial(" ")).toBe("?");
  });
});
