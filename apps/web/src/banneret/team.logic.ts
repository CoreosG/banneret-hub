// Banneret Hub: the Team page as pure functions over the relay's `team` file (joined with its
// machines on the server) and the board and map the feed already holds. Who is working on what:
// one row per person, their sessions as a tree (lead session, then its helpers), counted by state.
import type {
  BanneretBoardCard,
  BanneretBoards,
  BanneretBoardTask,
  BanneretMap,
  BanneretTeam,
  BanneretTeamPerson,
  BanneretTeamSession,
} from "@t3tools/contracts";
import { allBoardCards } from "@t3tools/contracts";

import { matchesText } from "./boards.logic";
import { roleLabel } from "./enterprise.logic";
import { humanizeWord } from "./ui/status";
import type { Tone } from "./ui/tokens";

/** The four groups of live agents, most urgent first. Idle sessions are in none of them. */
export type TeamGroup = "needs_you" | "waiting" | "not_heard_from" | "working";

export const TEAM_GROUPS: ReadonlyArray<{
  readonly id: TeamGroup;
  readonly label: string;
  readonly tone: Tone;
}> = [
  { id: "needs_you", label: "Needs you", tone: "warn" },
  { id: "waiting", label: "Waiting on someone else", tone: "info" },
  { id: "not_heard_from", label: "Not heard from", tone: "muted" },
  { id: "working", label: "Working", tone: "ok" },
];

// How urgent a session's own state is. `idle` and any state the Hub does not know count as idle.
const RANK: Readonly<Record<string, number>> = { waiting: 3, not_heard_from: 2, working: 1 };
const rankOf = (state: string) => RANK[state] ?? 0;

export interface SessionNode {
  readonly session: BanneretTeamSession;
  readonly children: ReadonlyArray<SessionNode>;
  /** The most urgent state in this session's subtree: a waiting helper makes its lead waiting. */
  readonly state: string;
}

/**
 * Sessions as trees: a session whose parent is listed sits under it. A parent that is missing, the
 * session itself, or a loop makes a session a root, so every session shows exactly once.
 */
export function sessionTrees(sessions: ReadonlyArray<BanneretTeamSession>): Array<SessionNode> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = new Map<string, Array<BanneretTeamSession>>();
  const isRoot = (session: BanneretTeamSession) =>
    session.parentId === undefined ||
    session.parentId === session.id ||
    !byId.has(session.parentId);
  for (const session of sessions) {
    if (isRoot(session)) continue;
    const parent = session.parentId!;
    children.set(parent, [...(children.get(parent) ?? []), session]);
  }
  const placed = new Set<string>();
  const build = (session: BanneretTeamSession): SessionNode => {
    placed.add(session.id);
    const kids = (children.get(session.id) ?? [])
      .filter((child) => !placed.has(child.id))
      .map(build);
    const state = kids.reduce(
      (best, child) => (rankOf(child.state) > rankOf(best) ? child.state : best),
      session.state,
    );
    return { session, children: kids, state };
  };
  const roots = sessions.filter(isRoot).map(build);
  // Sessions in a parent loop are reachable from no root: each unplaced one starts its own tree.
  for (const session of sessions) if (!placed.has(session.id)) roots.push(build(session));
  return roots;
}

const sameLogin = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Which group a lead session counts in. A wait is the viewer's to answer only on their own agents. */
export function groupOf(state: string, mine: boolean): TeamGroup | null {
  switch (state) {
    case "waiting":
      return mine ? "needs_you" : "waiting";
    case "not_heard_from":
      return "not_heard_from";
    case "working":
      return "working";
    default:
      return null;
  }
}

export type GroupCounts = Readonly<Record<TeamGroup, number>>;

const zeroCounts = (): Record<TeamGroup, number> => ({
  needs_you: 0,
  waiting: 0,
  not_heard_from: 0,
  working: 0,
});

/** A board task the person holds a lease on, with its card for the chip. */
export interface HeldLease {
  readonly card: BanneretBoardCard & { readonly lease: NonNullable<BanneretBoardCard["lease"]> };
}

export interface PersonRow {
  readonly person: BanneretTeamPerson;
  /** The viewer's own row. */
  readonly mine: boolean;
  readonly roles: string;
  readonly trees: ReadonlyArray<SessionNode>;
  /** Lead sessions per group; helpers count under their lead, never on their own. */
  readonly counts: GroupCounts;
  /** Lead sessions in no group (idle). */
  readonly idle: number;
  readonly leases: ReadonlyArray<HeldLease>;
}

/** Board and map tasks by id, so a session's `taskId` gets a title and opens in the Task dialog. */
export function taskIndex(
  boards: BanneretBoards | null | undefined,
  map: BanneretMap | null | undefined,
): ReadonlyMap<string, BanneretBoardTask> {
  const tasks = new Map<string, BanneretBoardTask>();
  for (const card of allBoardCards(boards)) tasks.set(card.task.id, card.task);
  for (const item of map?.items ?? []) {
    if (item.task !== undefined && !tasks.has(item.task.id)) tasks.set(item.task.id, item.task);
  }
  return tasks;
}

/** One row per person, in the relay's order. Leases come from the board cards, held by login. */
export function personRows(input: {
  readonly team: BanneretTeam;
  readonly meLogin: string | undefined;
  readonly boards: BanneretBoards | null | undefined;
}): Array<PersonRow> {
  const held = allBoardCards(input.boards).filter(
    (card): card is HeldLease["card"] => card.lease !== undefined,
  );
  return input.team.people.map((person) => {
    const mine = input.meLogin !== undefined && sameLogin(person.login, input.meLogin);
    const trees = sessionTrees(person.sessions);
    const counts = zeroCounts();
    let idle = 0;
    for (const tree of trees) {
      const group = groupOf(tree.state, mine);
      if (group === null) idle += 1;
      else counts[group] += 1;
    }
    return {
      person,
      mine,
      roles: roleLabel(person.role),
      trees,
      counts,
      idle,
      leases: held
        .filter((card) => sameLogin(card.lease.holder.login, person.login))
        .map((card) => ({ card })),
    };
  });
}

/** Lead sessions per group across everyone shown. */
export function totalCounts(rows: ReadonlyArray<PersonRow>): GroupCounts {
  const total = zeroCounts();
  for (const row of rows) {
    for (const group of TEAM_GROUPS) total[group.id] += row.counts[group.id];
  }
  return total;
}

/** The words a person filter matches: login, role, machines, held tasks and the tasks agents work on. */
function personText(row: PersonRow, tasks: ReadonlyMap<string, BanneretBoardTask>): Array<string> {
  return [
    row.person.login,
    row.roles,
    ...row.person.machines.map((machine) => machine.label),
    ...row.leases.map(({ card }) => card.task.title),
    ...row.person.sessions.flatMap((session) => {
      const task = session.taskId === undefined ? undefined : tasks.get(session.taskId);
      return task === undefined ? [] : [task.title];
    }),
  ];
}

/** The rows a person filter keeps; an empty filter keeps everyone. */
export function filterPeople(
  rows: ReadonlyArray<PersonRow>,
  query: string,
  tasks: ReadonlyMap<string, BanneretBoardTask>,
): Array<PersonRow> {
  return rows.filter((row) => matchesText(query, personText(row, tasks)));
}

/** "Claude", "Codex", or the relay's own word for a provider the Hub does not know. */
export const providerLabel = (provider: string) =>
  provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : humanizeWord(provider);

/** A session's own state in words. `not_heard_from` takes its time from the caller. */
export function sessionStateLabel(session: Pick<BanneretTeamSession, "state" | "waiting">): string {
  switch (session.state) {
    case "working":
      return "working";
    case "waiting":
      return session.waiting === "question"
        ? "waiting for an answer"
        : "waiting for a permission answer";
    case "idle":
      return "idle";
    case "not_heard_from":
      return "not heard from";
    default:
      return humanizeWord(session.state).toLowerCase();
  }
}

/** The tone of a session's dot: the group it would count in. */
export function sessionTone(state: string, mine: boolean): Tone {
  const group = groupOf(state, mine);
  return TEAM_GROUPS.find((entry) => entry.id === group)?.tone ?? "muted";
}

export function nameRank(login: string, query: string) {
  const name = login.toLowerCase();
  const term = query.trim().toLowerCase();
  return name === term ? 0 : name.startsWith(term) ? 1 : 2;
}

/** People for the `/` search: login, role or machine label. */
export function searchPeople(
  team: BanneretTeam | null | undefined,
  query: string,
  limit = 8,
): Array<BanneretTeamPerson> {
  if (query.trim() === "" || team == null) return [];
  return team.people
    .filter((person) =>
      matchesText(query, [
        person.login,
        roleLabel(person.role),
        ...person.machines.map((machine) => machine.label),
      ]),
    )
    .sort((a, b) => nameRank(a.login, query) - nameRank(b.login, query))
    .slice(0, limit);
}
