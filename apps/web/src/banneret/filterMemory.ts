// Banneret Hub: the last filters of Board (per board), Map and Feed in each workspace, for this window's
// session. A filter change on the page sets them, Clear filters or unsetting the last one empties them,
// and the sidebar fills them in when it opens the page. URL filters always win. Storage may be blocked.
import type { BanneretBoards } from "@t3tools/contracts";

import { rememberedBoard } from "./boardChoice";
import { pickBoard } from "./boards.logic";

export const FILTER_MEMORY_KEY = "banneret.page-filters.v1";

export type PageFilters = Readonly<Record<string, string>>;

/** The page a set of filters belongs to: a board by its id, or the Map or the Feed. */
export type FilterScope = `board:${string}` | "map" | "feed" | "team";

const slot = (workspaceId: string, scope: FilterScope) => `${workspaceId} ${scope}`;

function readAll(): Record<string, PageFilters> {
  try {
    const raw = globalThis.sessionStorage?.getItem(FILTER_MEMORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const all: Record<string, PageFilters> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      all[key] = Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
    return all;
  } catch {
    return {};
  }
}

/** Keeps a page's filters as they now are; none left forgets the page. */
export function rememberFilters(
  workspaceId: string,
  scope: FilterScope,
  filters: Readonly<Record<string, string | undefined>>,
): void {
  const kept = Object.fromEntries(
    Object.entries(filters).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
  const all = readAll();
  if (Object.keys(kept).length === 0) delete all[slot(workspaceId, scope)];
  else all[slot(workspaceId, scope)] = kept;
  try {
    globalThis.sessionStorage?.setItem(FILTER_MEMORY_KEY, JSON.stringify(all));
  } catch {
    // Blocked storage: the URL still carries the filters while the page is open.
  }
}

export function rememberedFilters(workspaceId: string, scope: FilterScope): PageFilters {
  return readAll()[slot(workspaceId, scope)] ?? {};
}

/**
 * The search the sidebar opens a page with: its remembered filters. Board's are those of the board
 * it will show (the remembered one, else the first), so they are known only once the boards are.
 */
export function restoredSearch(
  workspaceId: string,
  path: string,
  boards: BanneretBoards | null,
): PageFilters {
  if (path === "/team") return rememberedFilters(workspaceId, "team");
  if (path === "/map") return rememberedFilters(workspaceId, "map");
  if (path === "/feed") return rememberedFilters(workspaceId, "feed");
  if (path !== "/board") return {};
  const board = pickBoard(boards?.boards ?? [], undefined, rememberedBoard(workspaceId));
  return board === null ? {} : rememberedFilters(workspaceId, `board:${board.id}`);
}
