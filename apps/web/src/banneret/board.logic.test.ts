import type { BanneretBoard, BanneretBoardCard, BanneretBoardLease } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardColumns,
  columnCountsLine,
  heldBy,
  isMine,
  mineSummary,
  needsRelease,
  prLine,
  prSummary,
  statusCounts,
  statusWord,
  taskRef,
  unclaimedAssignees,
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
    expect(taskRef(task)).toEqual({ repo: "banneret-hub", number: "#58" });
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
      kind: "issue",
      column,
      status: "planned",
      statusWhy: "Open.",
      prs: [],
      assignees: [],
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

  it("counts Mine as held or assigned, and finds my expired and incomplete claims", () => {
    const held = (state: string, login = "ada") => ({
      lease: lease(state, 60 * 60_000, login),
      assignees: [{ login }],
    });
    const cards = [
      held("active"),
      held("expired", "Ada"),
      held("incomplete"),
      held("expired", "bo"),
      { assignees: [{ login: " ADA " }] },
      { assignees: [{ login: "bo" }] },
    ].map((extra, index): BanneretBoardCard => ({
      task: {
        id: String(index),
        title: String(index),
        ref: { tracker: "github", scope: "o/r", key: String(index), url: "https://x" },
        openedAt: "2026-11-20T09:00:00.000Z",
        closedAt: null,
      },
      kind: "issue",
      column: "taken",
      status: "planned",
      statusWhy: "Open.",
      prs: [],
      restsOn: [],
      ...extra,
    }));
    expect(cards.filter((card) => isMine(card, "ada")).map((c) => c.task.id)).toEqual([
      "0",
      "1",
      "2",
      "4",
    ]);
    expect(cards.filter((card) => needsRelease(card, "ada")).map((c) => c.task.id)).toEqual([
      "1",
      "2",
    ]);
    expect(mineSummary(cards, "ada")).toBe("4 assigned to you · 1 lease expired · 1 incomplete");
    expect(mineSummary(cards, "cy")).toBe("0 assigned to you · 0 leases expired");
    expect(unclaimedAssignees(cards[5]!)).toEqual(["bo"]);
    expect(unclaimedAssignees(cards[0]!)).toEqual([]);
    expect(unclaimedAssignees({ assignees: [{ login: " " }] })).toEqual([]);
  });
});
