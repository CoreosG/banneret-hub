// Banneret Hub: the open tabs bar's model, as pure functions over one saved object. A tab is a
// thread route (server thread, linked thread or draft) or a workspace page. A tab is a preview
// (kept: false, at most one) until double-click, pin or a sent message keeps it; pinned implies
// kept and is never evicted. Live title, offline and gone are derived on render, never saved.
import * as Schema from "effect/Schema";

export const MAX_TABS = 20;
export const TABS_STORAGE_KEY = "banneret.tabs.v1";

const PAGE_PATHS = ["/today", "/board", "/map", "/feed", "/needs", "/team"] as const;
export type PagePath = (typeof PAGE_PATHS)[number];

const TabThreadRef = Schema.Struct({ environmentId: Schema.String, threadId: Schema.String });
export type TabThreadRef = typeof TabThreadRef.Type;

const Tab = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["thread", "page"]),
  href: Schema.String,
  workspaceId: Schema.NullOr(Schema.String),
  threadRef: Schema.NullOr(TabThreadRef),
  title: Schema.String,
  pinned: Schema.Boolean,
  kept: Schema.Boolean,
  lastActiveAt: Schema.Number,
});
export type Tab = typeof Tab.Type;

export const TabsState = Schema.Struct({
  tabs: Schema.Array(Tab),
  activeId: Schema.NullOr(Schema.String),
  hidden: Schema.Boolean,
});
export type TabsState = typeof TabsState.Type;

export const EMPTY_TABS: TabsState = { tabs: [], activeId: null, hidden: false };

/** What the router shows, when it is something a tab can hold. */
export type TabTarget =
  | {
      readonly kind: "thread";
      readonly href: string;
      readonly threadRef: TabThreadRef | null;
      readonly title: string;
      /** A draft route: when the same thread later shows on a server route, the draft was sent. */
      readonly draft: boolean;
      /** The key of the draft tab this thread was sent from, when the thread got a new id. */
      readonly promotedFrom?: string | undefined;
    }
  | {
      readonly kind: "page";
      /** The page path plus its search, so a tab keeps the page's filters. */
      readonly href: string;
      readonly workspaceId: string | null;
      readonly title: string;
    };

/** A page tab's path without its search: filters change the tab's href, not which tab it is. */
const pagePath = (href: string) => href.split(/[?#]/, 1)[0] ?? href;

export function tabKey(tab: Pick<Tab, "kind" | "href" | "threadRef" | "workspaceId">): string {
  if (tab.kind === "page") return `page:${tab.workspaceId ?? ""}:${pagePath(tab.href)}`;
  return tab.threadRef === null
    ? `href:${tab.href}`
    : `thread:${tab.threadRef.environmentId}:${tab.threadRef.threadId}`;
}

function targetTab(target: TabTarget, id: string, now: number): Tab {
  return {
    id,
    kind: target.kind,
    href: target.href,
    workspaceId: target.kind === "page" ? target.workspaceId : null,
    threadRef: target.kind === "thread" ? target.threadRef : null,
    title: target.title,
    pinned: false,
    kept: false,
    lastActiveAt: now,
  };
}

export const targetKey = (target: TabTarget) => tabKey(targetTab(target, "", 0));

const isDraftHref = (href: string) => href.startsWith("/draft/");

/** Closes least recently used unpinned tabs, never the active one, until at most MAX_TABS remain. */
function evict(tabs: ReadonlyArray<Tab>, activeId: string | null): ReadonlyArray<Tab> {
  let kept = tabs;
  while (kept.length > MAX_TABS) {
    let victim: Tab | null = null;
    for (const tab of kept) {
      if (tab.pinned || tab.id === activeId) continue;
      if (victim === null || tab.lastActiveAt < victim.lastActiveAt) victim = tab;
    }
    if (victim === null) break;
    const removed = victim;
    kept = kept.filter((tab) => tab !== removed);
  }
  return kept;
}

/**
 * The router showed `target` (null: a route no tab holds). Activates its tab; otherwise the preview
 * tab becomes it in place, or a new preview opens at the end, evicting past MAX_TABS. With every
 * slot pinned, the new target gets no tab.
 */
export function observeTarget(
  state: TabsState,
  target: TabTarget | null,
  now: number,
  newId: () => string,
): TabsState {
  if (target === null) return state.activeId === null ? state : { ...state, activeId: null };
  const key = targetKey(target);
  const existing = state.tabs.find((tab) => tabKey(tab) === key);
  if (existing !== undefined) {
    // A draft keeps its thread id when it is sent, so its tab follows it to the server route.
    const sent = isDraftHref(existing.href) && target.kind === "thread" && !target.draft;
    const tabs = state.tabs.map((tab) =>
      tab === existing
        ? { ...tab, href: target.href, lastActiveAt: now, kept: tab.kept || sent }
        : tab,
    );
    return { ...state, tabs, activeId: existing.id };
  }
  const promoted =
    target.kind === "thread" && target.promotedFrom !== undefined
      ? state.tabs.find((tab) => tabKey(tab) === target.promotedFrom)
      : undefined;
  if (promoted !== undefined && target.kind === "thread") {
    const tabs = state.tabs.map((tab) =>
      tab === promoted
        ? { ...tab, href: target.href, threadRef: target.threadRef, lastActiveAt: now, kept: true }
        : tab,
    );
    return { ...state, tabs, activeId: promoted.id };
  }
  const created = targetTab(target, newId(), now);
  const previewIndex = state.tabs.findIndex((tab) => !tab.kept);
  const placed =
    previewIndex === -1
      ? [...state.tabs, created]
      : state.tabs.map((tab, index) => (index === previewIndex ? created : tab));
  const tabs = evict(placed, created.id);
  if (tabs.length > MAX_TABS) {
    return { ...state, tabs: tabs.filter((tab) => tab !== created), activeId: null };
  }
  return { ...state, tabs, activeId: created.id };
}

export function keepTab(state: TabsState, id: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id && !tab.kept ? { ...tab, kept: true } : tab)),
  };
}

export function togglePin(state: TabsState, id: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === id ? { ...tab, pinned: !tab.pinned, kept: true } : tab,
    ),
  };
}

export function setTabTitle(state: TabsState, id: string, title: string): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id && tab.title !== title ? { ...tab, title } : tab)),
  };
}

/**
 * Removes tabs. When the active one goes, `next` is the tab to show instead: the right neighbour,
 * then the left one, or null for home.
 */
export function closeTabs(
  state: TabsState,
  ids: ReadonlySet<string>,
): { state: TabsState; next: Tab | null; closedActive: boolean } {
  const tabs = state.tabs.filter((tab) => !ids.has(tab.id));
  if (tabs.length === state.tabs.length) return { state, next: null, closedActive: false };
  const closedActive = state.activeId !== null && ids.has(state.activeId);
  if (!closedActive) return { state: { ...state, tabs }, next: null, closedActive };
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  const right = state.tabs.slice(index + 1).find((tab) => !ids.has(tab.id));
  const left = state.tabs
    .slice(0, index)
    .toReversed()
    .find((tab) => !ids.has(tab.id));
  const next = right ?? left ?? null;
  return { state: { ...state, tabs, activeId: next?.id ?? null }, next, closedActive };
}

export function moveTab(state: TabsState, id: string, beforeId: string | null): TabsState {
  const moving = state.tabs.find((tab) => tab.id === id);
  if (moving === undefined || id === beforeId) return state;
  const rest = state.tabs.filter((tab) => tab.id !== id);
  const index = beforeId === null ? -1 : rest.findIndex((tab) => tab.id === beforeId);
  const tabs = index === -1 ? [...rest, moving] : rest.toSpliced(index, 0, moving);
  return { ...state, tabs };
}

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(TabsState));

/** The saved object, or null when it is missing or of another shape (the caller wipes it). */
export function parseTabsState(raw: string | null): TabsState | null {
  if (raw === null) return null;
  const decoded = decodeState(raw);
  if (decoded._tag === "None") return null;
  const state = decoded.value;
  // At most one preview and MAX_TABS tabs, or the saved copy is not one this code wrote.
  if (state.tabs.filter((tab) => !tab.kept).length > 1 || state.tabs.length > MAX_TABS) return null;
  if (state.tabs.some((tab) => tab.pinned && !tab.kept)) return null;
  return state;
}

export function pageTitle(path: PagePath): string {
  switch (path) {
    case "/today":
      return "Today";
    case "/board":
      return "Board";
    case "/map":
      return "Map";
    case "/feed":
      return "Feed";
    case "/needs":
      return "Needs";
    case "/team":
      return "Team";
  }
}

export function isPagePath(pathname: string): pathname is PagePath {
  return (PAGE_PATHS as ReadonlyArray<string>).includes(pathname);
}
