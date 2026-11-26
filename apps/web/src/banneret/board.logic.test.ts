import type { BanneretBoard, BanneretBoardLease } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agoLabel, boardColumns, leaseChip, prLine, statusWord } from "./board.logic";

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
    expect(statusWord("needs_you")).toEqual({ mark: "◆", word: "needs you or blocked" });
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

  it("joins the PR and checks, or says nothing", () => {
    expect(
      prLine({ pr: { number: 12, url: "https://x", state: "open" }, checks: { state: "passing" } }),
    ).toBe("PR #12 open · checks passing");
    expect(prLine({})).toBeNull();
  });

  it("keeps the relay's column order and puts a card of an unknown column under Other", () => {
    const card = (id: string, column: string) => ({
      task: { id, title: id, ref: { tracker: "github", scope: "o/r", key: id, url: "https://x" } },
      column,
      status: "planned",
      statusWhy: "Open.",
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
  });
});
