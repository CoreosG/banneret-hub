import type { BanneretBoard, BanneretBoardLease } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agoLabel,
  boardColumns,
  columnCountsLine,
  heldBy,
  leaseChip,
  prLine,
  prSummary,
  statusCounts,
  statusWord,
  taskRefLabel,
} from "./board.logic";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const lease = (state: string, sinceMs: number, login = "ada"): BanneretBoardLease => ({
  holder: { login },
  state,
  since: ago(sinceMs),
  lastSignalAt: ago(sinceMs),
  staleAt: ago(sinceMs - 6 * 3_600_000),
  expiresAt: ago(sinceMs - 24 * 3_600_000),
});

describe("board words", () => {
  it("names every known status with its mark and keeps an unknown one's words", () => {
    expect(statusWord("needs_you")).toEqual({ mark: "◆", word: "needs you" });
    expect(statusWord("blocked")).toEqual({ mark: "⊘", word: "blocked" });
    expect(statusWord("ruled_dead").mark).toBe("†");
    expect(statusWord("brand_new_state")).toEqual({ mark: "·", word: "brand new state" });
  });

  it("labels each lease state, with its tone", () => {
    expect(leaseChip(lease("active", 12 * 60_000), NOW)).toEqual({
      label: "ada · active 12 min ago",
      tone: "ok",
    });
    expect(leaseChip(lease("stale", 7 * 3_600_000 + 5 * 60_000), NOW)).toEqual({
      label: "ada · quiet 7 h",
      tone: "warn",
    });
    expect(leaseChip(lease("expired", 25 * 3_600_000), NOW)).toEqual({
      label: "ada · expired, should be released",
      tone: "error",
    });
    expect(leaseChip(lease("paused", 0), NOW).tone).toBe("muted");
    expect(leaseChip(lease("conflict", 0), NOW).tone).toBe("error");
    expect(leaseChip(lease("brand_new", 0), NOW)).toEqual({
      label: "ada · brand new",
      tone: "muted",
    });
  });

  it("drops an empty holder login without leaving a separator", () => {
    expect(leaseChip(lease("expired", 0, "  "), NOW).label).toBe("expired, should be released");
  });

  it("tells time in plain units", () => {
    expect(agoLabel(ago(10_000), NOW)).toBe("just now");
    expect(agoLabel(ago(3 * 3_600_000), NOW)).toBe("3 h ago");
    expect(agoLabel(ago(50 * 3_600_000), NOW)).toBe("2 d ago");
  });

  it("gives a linked PR its line, with its checks when the relay read them", () => {
    expect(
      prLine({ number: 12, url: "https://x", state: "open", checks: { state: "passing" } }),
    ).toBe("PR #12 open · checks passing");
    expect(prLine({ number: 9, url: "https://x", state: "closed" })).toBe("PR #9 closed");
  });

  it("sums a card's PRs with the worst check state among the open ones", () => {
    const pr = (number: number, state: string, checks?: string) => ({
      number,
      url: "https://x",
      state,
      ...(checks === undefined ? {} : { checks: { state: checks } }),
    });
    expect(prSummary([])).toBeNull();
    expect(prSummary([pr(61, "open", "pending")])).toEqual({
      label: "#61 open",
      merged: false,
      checks: { state: "pending", label: "checks pending" },
    });
    expect(prSummary([pr(402, "merged", "failing")])).toEqual({
      label: "#402 merged",
      merged: true,
      checks: null,
    });
    // A closed PR's failing checks no longer count; an unknown state ranks above pending.
    expect(
      prSummary([pr(9, "closed", "failing"), pr(12, "open", "passing"), pr(13, "open", "pending")]),
    ).toEqual({
      label: "3 pull requests, 2 open",
      merged: false,
      checks: { state: "pending", label: "checks pending" },
    });
    expect(prSummary([pr(1, "open", "pending"), pr(2, "open", "flaky")])?.checks).toEqual({
      state: "flaky",
      label: "checks flaky",
    });
    expect(prSummary([pr(1, "open", "flaky"), pr(2, "open", "failing")])?.checks?.state).toBe(
      "failing",
    );
  });

  it("names a task by repo and key, and matches lease holders case-insensitively", () => {
    const task = {
      id: "1",
      title: "t",
      ref: { tracker: "github", scope: "banneret-app/banneret-hub/", key: "58", url: "https://x" },
      openedAt: "2026-11-20T09:00:00.000Z",
      closedAt: null,
    };
    expect(taskRefLabel(task)).toBe("banneret-hub#58");
    expect(heldBy({ lease: lease("active", 0, " Ada ") }, "ada")).toBe(true);
    expect(heldBy({ lease: lease("active", 0, "bo") }, "ada")).toBe(false);
    expect(heldBy({ lease: lease("active", 0, "") }, "")).toBe(false);
    expect(heldBy({}, "ada")).toBe(false);
  });

  it("counts statuses from zero, except blocked, which counts only when sent", () => {
    expect(statusCounts([{ status: "planned" }, { status: "planned" }, { status: "odd" }])).toEqual(
      {
        needs_you: 0,
        sent_back: 0,
        built: 0,
        checked: 0,
        planned: 2,
        ruled_dead: 0,
        odd: 1,
      },
    );
    expect(statusCounts([{ status: "blocked" }]).blocked).toBe(1);
  });

  it("keeps the relay's column order and puts a card of an unknown column under Other", () => {
    const card = (id: string, column: string) => ({
      task: {
        id,
        title: id,
        ref: { tracker: "github", scope: "o/r", key: id, url: "https://x" },
        openedAt: "2026-11-20T09:00:00.000Z",
        closedAt: null,
      },
      column,
      status: "planned",
      statusWhy: "Open.",
      prs: [],
      restsOn: [],
    });
    const board: BanneretBoard = {
      state: "ok",
      notMeasured: [],
      columns: [
        { id: "free", title: "Free" },
        { id: "taken", title: "Taken" },
      ],
      cards: [card("a", "taken"), card("b", "free"), card("c", "brand_new")],
    };
    expect(
      boardColumns(board).map((column) => [column.title, column.cards.map((c) => c.task.id)]),
    ).toEqual([
      ["Free", ["b"]],
      ["Taken", ["a"]],
      ["Other", ["c"]],
    ]);
    expect(columnCountsLine(boardColumns(board))).toBe("1 free to take, 1 taken");
    expect(boardColumns(board, [card("a", "taken")]).map((c) => c.cards.length)).toEqual([0, 1]);
  });
});
