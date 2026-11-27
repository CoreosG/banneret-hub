import { describe, expect, it } from "vite-plus/test";

import { checkedView, previewStateLabel, restsOnItems, trackerName } from "./task.logic";
import { decodeTaskSurface, taskSurface, taskTabTitle } from "./taskSurface";

const task = {
  id: "t_1",
  title: "Rate limits",
  ref: {
    tracker: "github",
    scope: "example-org/app",
    key: "1",
    url: "https://github.com/example-org/app/issues/1",
  },
  openedAt: "2026-11-20T09:00:00.000Z",
  closedAt: null,
};

describe("Task tab words", () => {
  it("names known trackers and prints an unknown kind as the relay named it", () => {
    expect(trackerName("github")).toBe("GitHub");
    expect(trackerName("linear")).toBe("Linear");
    expect(trackerName("youtrack")).toBe("youtrack");
  });

  it("names preview states, keeping an unknown one readable", () => {
    expect(previewStateLabel("ready")).toBe("ready");
    expect(previewStateLabel("warming_up")).toBe("warming up");
  });

  it("shows a valid sign-off with who and when, and an ignored one with its reason", () => {
    expect(checkedView(undefined)).toEqual({ kind: "none" });
    expect(
      checkedView({ by: { login: " ada " }, at: "2026-11-26T10:00:00Z", valid: true }),
    ).toEqual({ kind: "valid", by: "ada", at: "2026-11-26T10:00:00Z" });
    expect(
      checkedView({
        by: { login: "bo" },
        at: "2026-11-26T10:00:00Z",
        valid: false,
        ignoredReason: "bo does not hold the sign-off role.",
      }),
    ).toEqual({ kind: "ignored", by: "bo", reason: "bo does not hold the sign-off role." });
    expect(
      checkedView({ by: { login: "bo" }, at: "2026-11-26T10:00:00Z", valid: false }),
    ).toMatchObject({ kind: "ignored", reason: "It does not meet the sign-off rule." });
  });

  it("titles what a task rests on from the board where it can", () => {
    const card = {
      task,
      column: "free",
      status: "planned",
      statusWhy: "Open.",
      prs: [],
      restsOn: [],
    };
    expect(restsOnItems(["t_1", "t_9"], [card])).toEqual([
      { id: "t_1", title: "Rate limits" },
      { id: "t_9", title: null },
    ]);
  });
});

describe("Task surface", () => {
  it("round-trips a saved surface and refuses one that is not a task", () => {
    const surface = taskSurface("local", task);
    expect(surface.id).toBe("task:local:t_1");
    // A saved tab keeps only what titles it and links out; the dates come from the relay.
    expect(surface.task).not.toHaveProperty("openedAt");
    expect(decodeTaskSurface(JSON.parse(JSON.stringify(surface)))).toEqual(surface);
    expect(decodeTaskSurface({ ...surface, environmentId: "" })).toBeNull();
    expect(
      decodeTaskSurface({ ...surface, task: { ...task, ref: { tracker: "github" } } }),
    ).toBeNull();
    expect(decodeTaskSurface(null)).toBeNull();
  });

  it("titles the tab with the task, or Task for a broken copy", () => {
    expect(taskTabTitle(taskSurface("local", task))).toBe("Rate limits");
    expect(taskTabTitle({ kind: "task" })).toBe("Task");
  });
});
