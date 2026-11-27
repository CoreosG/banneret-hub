// Banneret Hub: plain words for the board (relay-v1 "Board and leases"). The relay computes every
// status, column and lease state; these only name them. Every set is open, so each has a fallback.
import type {
  BanneretBoard,
  BanneretBoardCard,
  BanneretBoardLease,
  BanneretBoardPr,
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

/** One line per linked pull request, oldest first; empty when none is linked. */
export const prLines = (card: Pick<BanneretBoardCard, "prs">): ReadonlyArray<string> =>
  card.prs.map(prLine);

export interface BoardColumnView {
  readonly id: string;
  readonly title: string;
  readonly cards: ReadonlyArray<BanneretBoardCard>;
}

/** The relay's columns in its order; a card naming an unknown column goes to a trailing "Other". */
export function boardColumns(board: BanneretBoard): ReadonlyArray<BoardColumnView> {
  const known = new Set(board.columns.map((column) => column.id));
  const columns = board.columns.map((column) => ({
    id: column.id,
    title: column.title,
    cards: board.cards.filter((card) => card.column === column.id),
  }));
  const other = board.cards.filter((card) => !known.has(card.column));
  return other.length === 0 ? columns : [...columns, { id: "", title: "Other", cards: other }];
}

/** Whether part of the board could not be read, so it may be incomplete. */
export const boardIncomplete = (board: BanneretBoard) =>
  board.state !== "ok" || board.notMeasured.length > 0;
