import type {
  BanneretBoardCard,
  BanneretBoards,
  BanneretTeam,
  BanneretTeamSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterPeople,
  groupOf,
  personRows,
  searchPeople,
  sessionStateLabel,
  sessionTrees,
  taskIndex,
  totalCounts,
} from "./team.logic";

const session = (
  id: string,
  state: string,
  extra: Partial<BanneretTeamSession> = {},
): BanneretTeamSession => ({
  id,
  machineId: "m_1",
  provider: "claude",
  state,
  since: "2026-11-26T09:00:00.000Z",
  ...extra,
});

const card = (id: string, title: string, holder?: string): BanneretBoardCard => ({
  task: {
    id,
    title,
    ref: {
      tracker: "github",
      scope: "example-org/example-app",
      key: id,
      url: `https://github.com/example-org/example-app/issues/${id}`,
    },
    openedAt: "2026-11-20T09:00:00.000Z",
    closedAt: null,
  },
  kind: "issue",
  column: holder === undefined ? "free" : "taken",
  status: "planned",
  statusWhy: "Open.",
  ...(holder === undefined
    ? {}
    : {
        lease: {
          holder: { login: holder },
          state: "active",
          since: "2026-11-26T08:00:00.000Z",
          lastSignalAt: "2026-11-26T09:50:00.000Z",
          staleAt: "2026-11-26T15:50:00.000Z",
          expiresAt: "2026-11-27T09:50:00.000Z",
        },
      }),
  assignees: holder === undefined ? [] : [{ login: holder }],
  prs: [],
  restsOn: [],
});

const boards = (cards: ReadonlyArray<BanneretBoardCard>): BanneretBoards => ({
  boards: [
    {
      id: "platform",
      title: "Platform",
      mode: "dev",
      source: { kind: "filter" },
      counts: {},
      board: { state: "ok", notMeasured: [], columns: [], cards: [...cards] },
    },
  ],
});

const TEAM: BanneretTeam = {
  people: [
    {
      id: "p_ada",
      login: "ada-example",
      role: "founder",
      machines: [{ id: "m_1", label: "Ada server", kind: "server", connected: true }],
      sessions: [
        session("s_lead", "working", { taskId: "t_invites" }),
        session("s_helper", "waiting", { parentId: "s_lead", waiting: "permission" }),
        session("s_solo", "working"),
        session("s_idle", "idle"),
      ],
    },
    {
      id: "p_bo",
      login: "Bo-Example",
      role: "limited_staff",
      machines: [{ id: "m_2", label: "Bo laptop", kind: "laptop", connected: false }],
      sessions: [
        session("s_bo", "waiting", { machineId: "m_2", waiting: "question" }),
        session("s_bo_gone", "not_heard_from", { machineId: "m_2" }),
      ],
    },
    { id: "p_cy", login: "cy-example", role: "auditor", machines: [], sessions: [] },
  ],
};

describe("sessionTrees", () => {
  it("puts helpers under their lead and gives the lead the most urgent state below it", () => {
    const trees = sessionTrees(TEAM.people[0]!.sessions);
    expect(trees.map((tree) => [tree.session.id, tree.state])).toEqual([
      ["s_lead", "waiting"],
      ["s_solo", "working"],
      ["s_idle", "idle"],
    ]);
    expect(trees[0]!.children.map((child) => child.session.id)).toEqual(["s_helper"]);
  });

  it("shows every session once, whatever its parent says", () => {
    const trees = sessionTrees([
      session("s_orphan", "working", { parentId: "s_missing" }),
      session("s_self", "working", { parentId: "s_self" }),
      session("s_a", "working", { parentId: "s_b" }),
      session("s_b", "idle", { parentId: "s_a" }),
    ]);
    const ids: string[] = [];
    const walk = (nodes: typeof trees) => {
      for (const node of nodes) {
        ids.push(node.session.id);
        walk(node.children as typeof trees);
      }
    };
    walk(trees);
    expect(ids.toSorted()).toEqual(["s_a", "s_b", "s_orphan", "s_self"]);
  });
});

describe("grouping by state", () => {
  it("counts a wait as needs you only on the viewer's own agents", () => {
    expect(groupOf("waiting", true)).toBe("needs_you");
    expect(groupOf("waiting", false)).toBe("waiting");
    expect(groupOf("not_heard_from", true)).toBe("not_heard_from");
    expect(groupOf("working", false)).toBe("working");
    expect(groupOf("idle", true)).toBeNull();
    expect(groupOf("state_added_later", true)).toBeNull();
  });

  it("counts lead sessions per person, helpers under their lead, and holds leases by login", () => {
    const rows = personRows({
      team: TEAM,
      meLogin: "ADA-example",
      boards: boards([
        card("t_invites", "Guild invites", "ada-example"),
        card("t_profile", "Profile blocks", "bo-example"),
        card("t_free", "Free task"),
      ]),
    });
    const [ada, bo, cy] = rows;
    expect(ada!.mine).toBe(true);
    expect(ada!.counts).toEqual({ needs_you: 1, waiting: 0, not_heard_from: 0, working: 1 });
    expect(ada!.idle).toBe(1);
    expect(ada!.leases.map(({ card: held }) => held.task.id)).toEqual(["t_invites"]);
    expect(bo!.mine).toBe(false);
    expect(bo!.counts).toEqual({ needs_you: 0, waiting: 1, not_heard_from: 1, working: 0 });
    expect(bo!.leases.map(({ card: held }) => held.task.id)).toEqual(["t_profile"]);
    expect(cy!.roles).toBe("Staff");
    expect(cy!.trees).toEqual([]);
    expect(totalCounts(rows)).toEqual({
      needs_you: 1,
      waiting: 1,
      not_heard_from: 1,
      working: 1,
    });
  });
});

describe("person filter", () => {
  const rows = personRows({
    team: TEAM,
    meLogin: "ada-example",
    boards: boards([card("t_invites", "Guild invites", "ada-example")]),
  });
  const tasks = taskIndex(boards([card("t_invites", "Guild invites", "ada-example")]), null);
  const logins = (query: string) => filterPeople(rows, query, tasks).map((row) => row.person.login);

  it("matches login, role, machine and the tasks a person holds or works on", () => {
    expect(logins("")).toEqual(["ada-example", "Bo-Example", "cy-example"]);
    expect(logins("bo")).toEqual(["Bo-Example"]);
    expect(logins("founder")).toEqual(["ada-example"]);
    expect(logins("laptop")).toEqual(["Bo-Example"]);
    expect(logins("guild invites")).toEqual(["ada-example"]);
    expect(logins("nobody")).toEqual([]);
  });

  it("finds people for the / search, and nobody for an empty query", () => {
    expect(searchPeople(TEAM, "server").map((person) => person.login)).toEqual(["ada-example"]);
    expect(searchPeople(TEAM, "  ")).toEqual([]);
    expect(searchPeople(null, "ada")).toEqual([]);
  });
});

describe("sessionStateLabel", () => {
  it("says what a session waits on, and keeps an unknown state's own word", () => {
    expect(sessionStateLabel({ state: "waiting", waiting: "question" })).toBe(
      "waiting for an answer",
    );
    expect(sessionStateLabel({ state: "waiting", waiting: "permission" })).toBe(
      "waiting for a permission answer",
    );
    expect(sessionStateLabel({ state: "paused_by_admin" })).toBe("paused by admin");
  });
});
