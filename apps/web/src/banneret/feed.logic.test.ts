import type { BanneretFeedEntry, BanneretGraveyardEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  feedTypeLabel,
  importanceOf,
  mergeFeedEntries,
  mergeGraveyardEntries,
  openTaskTarget,
} from "./feed.logic";

const task = (id: string, url = `https://github.com/example-org/app/issues/${id}`) => ({
  id,
  title: `Task ${id}`,
  ref: { tracker: "github", scope: "example-org/app", key: id, url },
});

const entry = (id: string, at: string, summary = id): BanneretFeedEntry => ({
  id,
  type: "built",
  at,
  importance: "normal",
  summary,
});

const grave = (id: string, ruledAt: string): BanneretGraveyardEntry => ({
  task: task(id),
  cause: "superseded",
  ruledAt,
});

describe("feed words", () => {
  it("names known types and falls back for unknown ones", () => {
    expect(feedTypeLabel("pr_merged")).toBe("PR merged");
    expect(feedTypeLabel("lease_expired")).toBe("Lease expired");
    expect(feedTypeLabel("something_new")).toBe("Activity");
  });

  it("styles only the known importance values", () => {
    expect(importanceOf("high")).toBe("high");
    expect(importanceOf("low")).toBe("low");
    expect(importanceOf("normal")).toBe("normal");
    expect(importanceOf("urgent")).toBe("normal");
  });
});

describe("merging pages", () => {
  it("keeps the first copy of each feed entry, newest first", () => {
    const merged = mergeFeedEntries(
      [entry("b", "2026-11-26T10:02:00Z", "snapshot"), entry("a", "2026-11-26T10:03:00Z")],
      [entry("b", "2026-11-26T10:02:00Z", "page"), entry("c", "2026-11-26T10:01:00Z")],
    );
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(merged[1]!.summary).toBe("snapshot");
  });

  it("puts an unreadable time last and keys the graveyard by task", () => {
    expect(
      mergeFeedEntries([entry("x", "not a time"), entry("y", "2026-11-26T10:00:00Z")]).map(
        (item) => item.id,
      ),
    ).toEqual(["y", "x"]);
    expect(
      mergeGraveyardEntries(
        [grave("t1", "2026-11-26T10:00:00Z")],
        [grave("t1", "2026-11-26T10:00:00Z"), grave("t2", "2026-11-26T09:00:00Z")],
      ).map((item) => item.task.id),
    ).toEqual(["t1", "t2"]);
  });
});

describe("opening a task", () => {
  it("links out over http(s) only", () => {
    expect(openTaskTarget(task("1"))).toBe("https://github.com/example-org/app/issues/1");
    expect(openTaskTarget(task("2", "javascript:alert(1)"))).toBeNull();
  });
});
