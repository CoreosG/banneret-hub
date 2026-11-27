// Banneret Hub: plain words for the board (relay-v1 "Board and leases"). The relay computes every
// status, column and lease state; these only name them. Every set is open, so each has a fallback.
import type {
  BanneretBoard,
  BanneretBoardCard,
  BanneretBoardLease,
  BanneretBoardPr,
  BanneretBoardTask,
} from "@t3tools/contracts";

import { cleanLogin } from "./enterprise.logic";

export interface StatusWord {
  readonly mark: string;
  readonly word: string;
}

/** One vocabulary for Board, Map and Feed, in the relay's first-match order. */
export const STATUS_VOCABULARY: ReadonlyArray<StatusWord & { readonly status: string }> = [
  { status: "ruled_dead", mark: "†", word: "ruled dead" },
  { status: "checked", mark: "●", word: "checked" },
  { status: "sent_back", mark: "✕", word: "sent back" },
  { status: "needs_you", mark: "◆", word: "needs you" },
  { status: "blocked", mark: "⊘", word: "blocked" },
  { status: "built", mark: "◐", word: "built, unchecked" },
  { status: "planned", mark: "○", word: "planned" },
];

const BY_STATUS = new Map(STATUS_VOCABULARY.map((entry) => [entry.status, entry]));

/** An unknown status keeps its own words under a neutral mark. */
export function statusWord(status: string): StatusWord {
  const known = BY_STATUS.get(status);
  return known === undefined
    ? { mark: "·", word: status.replaceAll("_", " ") }
    : { mark: known.mark, word: known.word };
}

export type LeaseTone = "ok" | "warn" | "error" | "muted";

export interface LeaseChip {
  readonly label: string;
  readonly tone: LeaseTone;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "12 min ago", "3 h ago", "2 d ago"; "just now" under a minute. */
export function agoLabel(at: string, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - Date.parse(at));
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < 24 * HOUR) return `${Math.floor(elapsed / HOUR)} h ago`;
  return `${Math.floor(elapsed / (24 * HOUR))} d ago`;
}

function quietLabel(at: string, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - Date.parse(at));
  if (!Number.isFinite(elapsed)) return "quiet";
  return elapsed < 24 * HOUR
    ? `quiet ${Math.floor(elapsed / HOUR)} h`
    : `quiet ${Math.floor(elapsed / (24 * HOUR))} d`;
}

/** The lease chip: holder and state. An empty login drops the name, never leaving a separator. */
export function leaseChip(lease: BanneretBoardLease, nowMs: number): LeaseChip {
  const login = cleanLogin(lease.holder.login);
  const who = (text: string) => (login === "" ? text : `${login} · ${text}`);
  switch (lease.state) {
    case "active":
      return { label: who(`active ${agoLabel(lease.lastSignalAt, nowMs)}`), tone: "ok" };
    case "stale":
      return { label: who(quietLabel(lease.lastSignalAt, nowMs)), tone: "warn" };
    case "expired":
      return { label: who("expired, should be released"), tone: "error" };
    case "paused":
      return { label: who("paused"), tone: "muted" };
    case "conflict":
      return { label: who("conflict, two people claim this"), tone: "error" };
    default:
      return { label: who(lease.state.replaceAll("_", " ")), tone: "muted" };
  }
}

const PR_STATES: Readonly<Record<string, string>> = {
  open: "open",
  merged: "merged",
  closed: "closed",
};
const CHECK_STATES: Readonly<Record<string, string>> = {
  passing: "checks passing",
  failing: "checks failing",
  pending: "checks pending",
};

/** "PR #12 open · checks passing"; the checks part only when the relay read them. */
export function prLine(pr: BanneretBoardPr): string {
  const head = `PR #${pr.number} ${PR_STATES[pr.state] ?? pr.state.replaceAll("_", " ")}`;
  if (pr.checks === undefined) return head;
  return `${head} \u00b7 ${CHECK_STATES[pr.checks.state] ?? `checks ${pr.checks.state.replaceAll("_", " ")}`}`;
}

const CHECK_RANK: Readonly<Record<string, number>> = { passing: 0, pending: 1, failing: 3 };
const checkRank = (state: string) => CHECK_RANK[state] ?? 2;

export interface PrSummary {
  readonly label: string;
  /** All linked pull requests merged. */
  readonly merged: boolean;
  /** The worst check state among open pull requests, when the relay read any. */
  readonly checks: { readonly state: string; readonly label: string } | null;
}

/**
 * One line for a card's pull requests: "#61 open" for one, "3 pull requests, 1 open" for more,
 * with the worst check state among the open ones. Checks on closed or merged ones no longer
 * matter, so they are left out. Null when none is linked.
 */
export function prSummary(prs: ReadonlyArray<BanneretBoardPr>): PrSummary | null {
  const first = prs[0];
  if (first === undefined) return null;
  const open = prs.filter((pr) => pr.state === "open");
  const label =
    prs.length === 1
      ? `#${first.number} ${PR_STATES[first.state] ?? first.state.replaceAll("_", " ")}`
      : `${prs.length} pull requests, ${open.length} open`;
  let worst: string | null = null;
  for (const pr of open) {
    const state = pr.checks?.state;
    if (state !== undefined && (worst === null || checkRank(state) > checkRank(worst))) {
      worst = state;
    }
  }
  return {
    label,
    merged: prs.every((pr) => pr.state === "merged"),
    checks:
      worst === null
        ? null
        : {
            state: worst,
            label: CHECK_STATES[worst] ?? `checks ${worst.replaceAll("_", " ")}`,
          },
  };
}

/** "banneret-hub" and "#58": the last part of the tracker scope and the task's key. */
export function taskRef(task: BanneretBoardTask): {
  readonly repo: string;
  readonly number: string;
} {
  const repo =
    task.ref.scope
      .split("/")
      .filter((part) => part.trim() !== "")
      .at(-1) ?? "";
  return { repo, number: `#${task.ref.key}` };
}

/** Whether `login` holds the card's lease. Logins compare case-insensitively. */
export function heldBy(card: Pick<BanneretBoardCard, "lease">, login: string): boolean {
  const holder = cleanLogin(card.lease?.holder.login).toLowerCase();
  return holder !== "" && holder === cleanLogin(login).toLowerCase();
}

const LEGEND_ZEROS = ["needs_you", "sent_back", "built", "checked", "planned", "ruled_dead"];

/** Cards per status for the legend: every known status starts at 0, except `blocked`. */
export function statusCounts(
  cards: ReadonlyArray<Pick<BanneretBoardCard, "status">>,
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(LEGEND_ZEROS.map((s) => [s, 0]));
  for (const card of cards) counts[card.status] = (counts[card.status] ?? 0) + 1;
  return counts;
}

const COLUMN_HINTS: Readonly<Record<string, string>> = {
  free: "Nobody has claimed these.",
  taken: "Claimed and being built.",
  validating: "A pull request is ready.",
  stuck: "Blocked, quiet or failing.",
  shipped: "Merged or closed as done.",
};

/** A short line under a known column's name; none for a column the hub does not know. */
export const columnHint = (id: string): string | undefined => COLUMN_HINTS[id];

/** "3 free to take, 2 taken, 3 stuck, 4 shipped" from the known columns that exist. */
export function columnCountsLine(columns: ReadonlyArray<BoardColumnView>): string {
  const count = (id: string) => columns.find((column) => column.id === id)?.cards.length;
  const parts: Array<string> = [];
  const free = count("free");
  if (free !== undefined) parts.push(`${free} free to take`);
  for (const id of ["taken", "stuck", "shipped"]) {
    const n = count(id);
    if (n !== undefined) parts.push(`${n} ${id}`);
  }
  return parts.join(", ");
}

export interface BoardColumnView {
  readonly id: string;
  readonly title: string;
  readonly cards: ReadonlyArray<BanneretBoardCard>;
}

/** The relay's columns in its order; a card naming an unknown column goes to a trailing "Other". */
export function boardColumns(
  board: BanneretBoard,
  cards: ReadonlyArray<BanneretBoardCard> = board.cards,
): ReadonlyArray<BoardColumnView> {
  const known = new Set(board.columns.map((column) => column.id));
  const columns = board.columns.map((column) => ({
    id: column.id,
    title: column.title,
    cards: cards.filter((card) => card.column === column.id),
  }));
  const other = cards.filter((card) => !known.has(card.column));
  return other.length === 0 ? columns : [...columns, { id: "", title: "Other", cards: other }];
}

/** Whether part of the board could not be read, so it may be incomplete. */
export const boardIncomplete = (board: BanneretBoard) =>
  board.state !== "ok" || board.notMeasured.length > 0;
