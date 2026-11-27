// Banneret Hub: several boards per company, their filters and the `/` search, as pure functions over
// the snapshot data the feed already holds. Filter state lives in the URL, so tabs and links keep it.
import type {
  BanneretBoardCard,
  BanneretBoardEntry,
  BanneretBoardTask,
  BanneretBoards,
  BanneretFeedEntry,
  BanneretMap,
  BanneretMapItem,
} from "@t3tools/contracts";
import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";

import { cleanLogin } from "./enterprise.logic";
import { statusWord, taskRef } from "./board.logic";

/** The Board page's URL state. Every key is optional; an empty filter is left out of the URL. */
export interface BoardSearch {
  readonly board?: string | undefined;
  readonly repo?: string | undefined;
  readonly person?: string | undefined;
  readonly status?: string | undefined;
  readonly q?: string | undefined;
}

// The router reads a bare `repo=42` as a number.
const bounded = (value: unknown): string | undefined => {
  const text = typeof value === "number" ? String(value) : value;
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed ? trimmed.slice(0, splitsSurrogatePair(trimmed, 200) ? 199 : 200) : undefined;
};

/** The text filter of Board, Map and Feed: `q`, trimmed and capped. */
export const queryFromUrl = (raw: Readonly<Record<string, unknown>>): string =>
  bounded(raw.q) ?? "";

export const boardSearchFromUrl = (raw: Readonly<Record<string, unknown>>): BoardSearch => ({
  board: bounded(raw.board),
  repo: bounded(raw.repo),
  person: bounded(raw.person),
  status: bounded(raw.status),
  q: bounded(raw.q),
});

/** Whether any filter (not the board choice) is set. */
export const hasFilters = (search: BoardSearch) =>
  search.repo !== undefined ||
  search.person !== undefined ||
  search.status !== undefined ||
  search.q !== undefined;

/**
 * The board to show: the URL's when the index has it, else the one remembered for the workspace,
 * else the first. An unknown id falls back without being written anywhere.
 */
export function pickBoard(
  boards: ReadonlyArray<BanneretBoardEntry>,
  fromUrl: string | undefined,
  remembered: string | null,
): BanneretBoardEntry | null {
  return (
    boards.find((entry) => entry.id === fromUrl) ??
    boards.find((entry) => entry.id === remembered) ??
    boards[0] ??
    null
  );
}

/** "12 tasks" from a board's index counts. */
export function boardSizeLabel(entry: Pick<BanneretBoardEntry, "counts">): string {
  const total = Object.values(entry.counts).reduce((sum, count) => sum + count, 0);
  return total === 1 ? "1 task" : `${total} tasks`;
}

const fold = (value: string) => value.trim().toLowerCase();

/** Every word of `query` appears in one of `fields`, ignoring case. An empty query matches all. */
export function matchesText(query: string, fields: ReadonlyArray<string | undefined>): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields
    .filter((field): field is string => field !== undefined)
    .map(fold)
    .join("\n");
  return words.every((word) => haystack.includes(word));
}

const cardPeople = (card: Pick<BanneretBoardCard, "lease" | "assignees">) => {
  const logins = [card.lease?.holder.login, ...card.assignees.map((person) => person.login)];
  return logins.map((login) => cleanLogin(login)).filter((login) => login !== "");
};

const taskText = (task: BanneretBoardTask) => {
  const ref = taskRef(task);
  // "example-app#3" as the card shows it, besides the full repository and the bare number.
  return [task.title, task.ref.scope, `${ref.repo}${ref.number}`, task.id];
};

/** The words a card is found by: title, repository, number, people and status. */
const cardText = (card: BanneretBoardCard) => [
  ...taskText(card.task),
  ...cardPeople(card),
  statusWord(card.status).word,
];

/** The cards that pass every set filter. Repository and person compare without case. */
export function filterCards(
  cards: ReadonlyArray<BanneretBoardCard>,
  search: BoardSearch,
): ReadonlyArray<BanneretBoardCard> {
  if (!hasFilters(search)) return cards;
  const repo = search.repo === undefined ? undefined : fold(search.repo);
  const person = search.person === undefined ? undefined : fold(search.person);
  return cards.filter(
    (card) =>
      (repo === undefined || fold(card.task.ref.scope) === repo) &&
      (person === undefined || cardPeople(card).some((login) => fold(login) === person)) &&
      (search.status === undefined || card.status === search.status) &&
      matchesText(search.q ?? "", cardText(card)),
  );
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The choices for each filter, from every card of the board (not the filtered ones), so a chosen
 * option never disappears. A chosen value the board lacks stays listed, so it can be cleared.
 */
export function filterOptions(
  cards: ReadonlyArray<BanneretBoardCard>,
  search: BoardSearch,
): {
  readonly repos: ReadonlyArray<FilterOption>;
  readonly people: ReadonlyArray<FilterOption>;
  readonly statuses: ReadonlyArray<FilterOption>;
} {
  const repos = new Map<string, string>();
  const people = new Map<string, string>();
  const statuses = new Map<string, string>();
  for (const card of cards) {
    repos.set(fold(card.task.ref.scope), card.task.ref.scope);
    for (const login of cardPeople(card)) people.set(fold(login), login);
    statuses.set(card.status, statusWord(card.status).word);
  }
  if (search.repo !== undefined && !repos.has(fold(search.repo)))
    repos.set(fold(search.repo), search.repo);
  if (search.person !== undefined && !people.has(fold(search.person)))
    people.set(fold(search.person), search.person);
  if (search.status !== undefined && !statuses.has(search.status))
    statuses.set(search.status, statusWord(search.status).word);
  const sorted = (entries: Iterable<FilterOption>) =>
    [...entries].toSorted((a, b) => a.label.localeCompare(b.label));
  return {
    repos: sorted(
      [...repos.values()].map((scope) => ({
        value: scope,
        label: scope.split("/").filter(Boolean).at(-1) ?? scope,
      })),
    ),
    people: sorted([...people.values()].map((login) => ({ value: login, label: login }))),
    statuses: sorted([...statuses].map(([value, label]) => ({ value, label }))),
  };
}

const LIMIT = 20;

export interface CardHit {
  readonly boardId: string;
  readonly boardTitle: string;
  readonly card: BanneretBoardCard;
}

export interface CompanyHits {
  readonly cards: ReadonlyArray<CardHit>;
  readonly mapItems: ReadonlyArray<BanneretMapItem>;
  readonly feed: ReadonlyArray<BanneretFeedEntry>;
}

const EMPTY_HITS: CompanyHits = { cards: [], mapItems: [], feed: [] };

/**
 * The `/` search over the active workspace's snapshot: every board's cards, the map's items and
 * the feed's entries, at most 20 of each. A task on two boards is found once. Empty query, no hits.
 */
export function searchCompany(
  query: string,
  data: {
    readonly boards: BanneretBoards | null;
    readonly map: BanneretMap | null;
    readonly feed: ReadonlyArray<BanneretFeedEntry>;
  },
): CompanyHits {
  if (fold(query) === "") return EMPTY_HITS;
  const seen = new Set<string>();
  const cards: Array<CardHit> = [];
  for (const entry of data.boards?.boards ?? []) {
    for (const card of entry.board?.cards ?? []) {
      if (cards.length >= LIMIT) break;
      if (seen.has(card.task.id) || !matchesText(query, cardText(card))) continue;
      seen.add(card.task.id);
      cards.push({ boardId: entry.id, boardTitle: entry.title, card });
    }
  }
  const mapItems = (data.map?.items ?? [])
    .filter((item) =>
      matchesText(query, [item.title, ...(item.task === undefined ? [] : taskText(item.task))]),
    )
    .slice(0, LIMIT);
  const feed = data.feed
    .filter((entry) =>
      matchesText(query, [
        entry.summary,
        entry.author?.login,
        ...(entry.task === undefined ? [] : taskText(entry.task)),
      ]),
    )
    .slice(0, LIMIT);
  return { cards, mapItems, feed };
}

/** A feed entry's words for the Feed page's text filter. */
export const feedEntryText = (entry: BanneretFeedEntry) => [
  entry.summary,
  entry.author?.login,
  ...(entry.task === undefined ? [] : taskText(entry.task)),
];

/** A graveyard entry's words: the task and the cause. */
export const graveyardEntryText = (entry: {
  readonly task: BanneretBoardTask;
  readonly cause: string;
  readonly by?: { readonly login: string } | undefined;
}) => [...taskText(entry.task), entry.cause, entry.by?.login];

/** A map item's words for the Map page's text filter. */
export const mapItemText = (item: BanneretMapItem) => [
  item.title,
  ...(item.task === undefined ? [] : taskText(item.task)),
];

/**
 * Whether a key press should open the `/` search: the bare `/` key, outside every text field
 * (inputs, text areas, the composer and the terminal are content-editable or text areas).
 */
export function opensSearch(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
}): boolean {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.isComposing || event.defaultPrevented) return false;
  const target = event.target;
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return true;
  if (target.isContentEditable) return false;
  return target.closest("input, textarea, select, [contenteditable]") === null;
}
