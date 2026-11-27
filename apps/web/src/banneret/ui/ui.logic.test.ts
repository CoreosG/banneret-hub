import { describe, expect, it } from "vite-plus/test";

import { healthLabel, leaseLabel, reasonLabel } from "./labels";
import { agoLabel, durationLabel, exactTimeLabel, spanLabel } from "./relativeTime";
import { legendStatuses, statusView } from "./status";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("statusView", () => {
  it.each([
    ["checked", "Checked", "ok", "check", false, false],
    ["built", "Built, needs a check", "info", "half", false, false],
    ["needs_you", "Needs you", "warn", "diamond", true, false],
    ["blocked", "Blocked", "warn", "octagon", false, false],
    ["sent_back", "Sent back", "error", "return", true, false],
    ["planned", "Not built yet", "muted", "dashed", false, false],
    ["ruled_dead", "Dropped", null, "slash", false, true],
    ["waiting_on_vendor", "Waiting on vendor", "muted", "dot", false, false],
    ["", "Unknown", "muted", "dot", false, false],
  ] as const)("%s reads %s", (status, label, tone, icon, accent, struck) => {
    expect(statusView(status)).toEqual({ status, label, tone, icon, accent, struck });
  });

  it("names what a blocked item waits on, and only for blocked", () => {
    expect(statusView("blocked", { blockedBy: "Sign-in page" }).label).toBe(
      "Blocked by Sign-in page",
    );
    expect(statusView("blocked", { blockedBy: "  " }).label).toBe("Blocked");
    expect(statusView("planned", { blockedBy: "Sign-in page" }).label).toBe("Not built yet");
  });
});

describe("legendStatuses", () => {
  it("lists known statuses, adds blocked only when counted, and keeps extra statuses", () => {
    expect(legendStatuses(undefined)).not.toContain("blocked");
    expect(legendStatuses({ blocked: 2, odd_one: 1 })).toEqual([
      "needs_you",
      "blocked",
      "sent_back",
      "built",
      "checked",
      "planned",
      "ruled_dead",
      "odd_one",
    ]);
    expect(legendStatuses({ blocked: 2 }, ["built"])).toEqual(["built"]);
  });
});

describe("relative time", () => {
  it.each([
    [ago(10_000), "just now", "0 min"],
    [ago(-5 * MIN), "just now", "0 min"],
    [ago(12 * MIN), "12 min ago", "12 min"],
    [ago(3 * HOUR + 5 * MIN), "3 h ago", "3 h"],
    [ago(2 * DAY + HOUR), "2 d ago", "2 d"],
    ["not a date", "", ""],
  ])("%s", (at, agoText, spanText) => {
    expect(agoLabel(at, NOW)).toBe(agoText);
    expect(spanLabel(at, NOW)).toBe(spanText);
  });

  it("says how long a state lasted, and the date once it is a week old", () => {
    expect(durationLabel(ago(10_000), NOW)).toBe("for under a minute");
    expect(durationLabel(ago(12 * MIN), NOW)).toBe("for 12 min");
    expect(durationLabel(ago(HOUR + MIN), NOW)).toBe("for 1 hour");
    expect(durationLabel(ago(3 * HOUR), NOW)).toBe("for 3 hours");
    expect(durationLabel(ago(DAY + HOUR), NOW)).toBe("for 1 day");
    expect(durationLabel(ago(6 * DAY), NOW)).toBe("for 6 days");
    expect(durationLabel(ago(8 * DAY), NOW)).toMatch(/^since Nov 1[89]$/);
    expect(durationLabel(ago(400 * DAY), NOW)).toMatch(/^since [A-Z][a-z]{2} \d{1,2}, 2025$/);
    expect(durationLabel("not a date", NOW)).toBe("");
  });

  it("formats the exact time in English whatever the system locale", () => {
    expect(exactTimeLabel("2026-11-27T12:00:00.000Z")).toMatch(
      /^Nov 2[67], 2026, \d{1,2}:\d{2}\s[AP]M$/,
    );
    expect(exactTimeLabel("garbage")).toBe("");
  });
});

describe("labels", () => {
  it.each([
    ["active", ago(-MIN), "live", "muted"],
    ["active", ago(0), "quiet", "warn"],
    ["stale", ago(7 * HOUR), "quiet", "warn"],
    ["expired", ago(DAY), "expired, should be released", "error"],
    ["paused", ago(DAY), "paused", "muted"],
    ["conflict", ago(DAY), "conflict, two people claim this", "error"],
    ["handed_over", ago(DAY), "handed over", "muted"],
  ])("lease %s", (state, staleAt, label, tone) => {
    expect(leaseLabel({ state, staleAt }, NOW)).toEqual({ label, tone });
  });

  it.each([
    ["dev_red", "Dev branch red", "error"],
    ["check_failed", "Checks failing", "error"],
    ["deploy_failed", "Deploy failed", "error"],
    ["watched_job_down", "Server job down", "error"],
    ["unreviewed", "Not reviewed", "warn"],
    ["claim_quiet", "Quiet claim", "warn"],
    ["checks_queued", "Checks queued", "muted"],
    ["cosmic_rays", "Cosmic rays", "muted"],
  ])("reason %s", (reason, label, tone) => {
    expect(reasonLabel(reason)).toEqual({ label, tone });
  });

  it.each([
    ["good", "Healthy", "ok"],
    ["warning", "Warning", "warn"],
    ["bad", "Failing", "error"],
    ["not_measured", "Not measured", "muted"],
    ["degraded", "Degraded", "muted"],
  ])("health %s", (state, label, tone) => {
    expect(healthLabel(state)).toEqual({ label, tone });
  });
});
