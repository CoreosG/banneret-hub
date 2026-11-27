import type { BanneretBoardCard, BanneretFeedEntry, BanneretMap } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardSearchFromUrl,
  boardSizeLabel,
  filterCards,
  filterOptions,
  opensSearch,
  pickBoard,
  searchCompany,
} from "./boards.logic";
import { boardEntry } from "./boards.testkit";

const card = (
  id: string,
  title: string,
  scope: string,
  extra: Partial<BanneretBoardCard> = {},
): BanneretBoardCard => ({
  task: {
    id,
    title,
    ref: { tracker: "github", scope, key: id, url: `https://github.com/${scope}/issues/${id}` },
    openedAt: "2026-11-20T09:00:00.000Z",
    closedAt: null,
  },
  kind: "issue",
  column: "free",
  status: "planned",
  statusWhy: "Open.",
  prs: [],
  assignees: [],
  restsOn: [],
  ...extra,
});

const board = (cards: BanneretBoardCard[]) => ({
  state: "ok",
  notMeasured: [],
  columns: [{ id: "free", title: "Free" }],
  cards,
});

const lease = (login: string): BanneretBoardCard["lease"] => ({
  holder: { login },
  state: "active",
  since: "2026-11-26T09:00:00.000Z",
  lastSignalAt: "2026-11-26T09:00:00.000Z",
  staleAt: "2026-11-26T15:00:00.000Z",
  expiresAt: "2026-11-27T09:00:00.000Z",
});

const CARDS = [
  card("1", "Rate limits", "example-org/app", { lease: lease("bo-example") }),
  card("2", "Guild invites", "example-org/app", {
    status: "needs_you",
    assignees: [{ login: "Ada-Example" }],
  }),
  card("3", "Deploy pipeline", "example-org/ops"),
];

describe("boards", () => {
  it("picks the URL's board, then the remembered one, then the first", () => {
    const boards = [boardEntry("platform", "Platform", null), boardEntry("ops", "Ops", null)];
    expect(pickBoard(boards, "ops", "platform")?.id).toBe("ops");
    expect(pickBoard(boards, "gone", "ops")?.id).toBe("ops");
    expect(pickBoard(boards, undefined, "gone")?.id).toBe("platform");
    expect(pickBoard([], "ops", "ops")).toBeNull();
    expect(boardSizeLabel(boardEntry("p", "P", board(CARDS)))).toBe("3 tasks");
    expect(boardSizeLabel({ counts: { free: 1 } })).toBe("1 task");
  });

  it("reads the URL's filters, a number as text, and leaves empty ones out", () => {
    expect(boardSearchFromUrl({ board: "ops", repo: 42, person: " ", q: " deploy " })).toEqual({
      board: "ops",
      repo: "42",
      person: undefined,
      status: undefined,
      q: "deploy",
    });
  });

  it("filters by repository, lease holder or assignee, status and text, ignoring case", () => {
    const ids = (search: Parameters<typeof filterCards>[1]) =>
      filterCards(CARDS, search).map((entry) => entry.task.id);
    expect(ids({})).toEqual(["1", "2", "3"]);
    expect(ids({ repo: "EXAMPLE-ORG/APP" })).toEqual(["1", "2"]);
    expect(ids({ person: "bo-example" })).toEqual(["1"]);
    expect(ids({ person: "ada-example" })).toEqual(["2"]);
    expect(ids({ status: "needs_you" })).toEqual(["2"]);
    expect(ids({ q: "pipeline OPS" })).toEqual(["3"]);
    expect(ids({ q: "needs you" })).toEqual(["2"]);
    expect(ids({ q: "app#1" })).toEqual(["1"]);
    expect(ids({ repo: "example-org/app", q: "deploy" })).toEqual([]);
  });

  it("offers every value of the board, and keeps a chosen value the board lacks", () => {
    const options = filterOptions(CARDS, { person: "gone-example" });
    expect(options.repos).toEqual([
      { value: "example-org/app", label: "app" },
      { value: "example-org/ops", label: "ops" },
    ]);
    expect(options.people.map((option) => option.value)).toEqual([
      "Ada-Example",
      "bo-example",
      "gone-example",
    ]);
    expect(options.statuses).toEqual([
      { value: "needs_you", label: "needs you" },
      { value: "planned", label: "planned" },
    ]);
  });

  it("searches every board's cards once, the map and the feed", () => {
    const shared = card("1", "Rate limits", "example-org/app");
    const boards = {
      boards: [
        boardEntry("platform", "Platform", board([shared])),
        boardEntry("ops", "Ops", board([shared, card("9", "Rate the backups", "example-org/ops")])),
        boardEntry("empty", "Empty", null),
      ],
    };
    const map: BanneretMap = {
      state: "ok",
      notMeasured: [],
      stages: [{ id: "s1", title: "Launch", order: 1 }],
      items: [
        {
          id: "i1",
          stageId: "s1",
          title: "Rate card",
          status: "planned",
          statusWhy: "Open.",
          restsOn: [],
          blockedBy: [],
        },
      ],
      counters: { byStatus: {}, byStage: {} },
    };
    const feed: BanneretFeedEntry[] = [
      {
        id: "f1",
        type: "built",
        at: "2026-11-26T09:00:00Z",
        importance: "normal",
        summary: "Rate limits built",
      },
      {
        id: "f2",
        type: "built",
        at: "2026-11-26T09:00:00Z",
        importance: "normal",
        summary: "Other",
      },
    ];
    const hits = searchCompany("rate", { boards, map, feed });
    expect(hits.cards.map((hit) => [hit.boardId, hit.card.task.id])).toEqual([
      ["platform", "1"],
      ["ops", "9"],
    ]);
    expect(hits.mapItems.map((item) => item.id)).toEqual(["i1"]);
    expect(hits.feed.map((entry) => entry.id)).toEqual(["f1"]);
    expect(searchCompany("  ", { boards, map, feed })).toEqual({
      cards: [],
      mapItems: [],
      feed: [],
    });
  });

  it("opens search on the key that types a slash, whatever the layout", () => {
    const key = (extra: Partial<Parameters<typeof opensSearch>[0]> = {}) => ({
      key: "/",
      code: "Slash",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      target: null,
      ...extra,
    });
    const altGraph = () => true;
    expect(opensSearch(key())).toBe(true);
    // Numpad, Brazilian ABNT2 (the key by right Shift) and German Shift+7.
    expect(opensSearch(key({ code: "NumpadDivide" }))).toBe(true);
    expect(opensSearch(key({ code: "IntlRo" }))).toBe(true);
    expect(opensSearch(key({ code: "Digit7", shiftKey: true }))).toBe(true);
    // AltGr+Q on a Brazilian laptop: Windows reports Ctrl+Alt with AltGraph.
    expect(
      opensSearch(key({ code: "KeyQ", ctrlKey: true, altKey: true, getModifierState: altGraph })),
    ).toBe(true);
    // The physical slash key on a layout that types something else there.
    expect(opensSearch(key({ key: ".", code: "Slash" }))).toBe(true);
    expect(opensSearch(key({ key: "?", shiftKey: true }))).toBe(false);
    expect(opensSearch(key({ key: "q", code: "KeyQ" }))).toBe(false);
    expect(opensSearch(key({ metaKey: true }))).toBe(false);
    expect(opensSearch(key({ ctrlKey: true }))).toBe(false);
    expect(opensSearch(key({ altKey: true }))).toBe(false);
    expect(
      opensSearch(
        key({ key: "q", code: "KeyQ", ctrlKey: true, altKey: true, getModifierState: altGraph }),
      ),
    ).toBe(false);
    expect(opensSearch(key({ isComposing: true }))).toBe(false);
    expect(opensSearch(key({ defaultPrevented: true }))).toBe(false);
  });
});
