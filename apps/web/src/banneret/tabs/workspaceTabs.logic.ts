// Banneret Hub: "Tabs show: Workspaces", one tab per project (a sidebar project group, not a
// workspace switcher choice), as pure functions over one saved object. Each saved field notes what
// changes and resets it. The shown workspace is derived (shownWorkspace); nothing else is held.
import * as Schema from "effect/Schema";

export const WORKSPACE_TABS_STORAGE_KEY = "banneret.tabs.workspaces.v1";

/** Every machine's "No project" home, and any stale twin of it, is one workspace. */
export const NO_PROJECT_KEY = "no-project";

const WorkspaceChat = Schema.Struct({
  href: Schema.String,
  threadRef: Schema.NullOr(
    Schema.Struct({ environmentId: Schema.String, threadId: Schema.String }),
  ),
});
export type WorkspaceChat = typeof WorkspaceChat.Type;

// Entry order is the tab order: a drag changes it, and a new or reopened tab goes last.
const WorkspaceEntry = Schema.Struct({
  key: Schema.String,
  // The projects' folders, rewritten on every visit: a project's group key can move.
  members: Schema.Array(Schema.String),
  // Set by showing a chat or picking the workspace; closing the tab clears it (hidden).
  open: Schema.Boolean,
  // Set and cleared by pin and unpin; closing the tab clears it.
  pinned: Schema.Boolean,
  visitedAt: Schema.Number,
  // The chat of this project shown last. Cleared once its thread is deleted or archived.
  lastChat: Schema.NullOr(WorkspaceChat),
});
export type WorkspaceEntry = typeof WorkspaceEntry.Type;

// A tab whose project is not listed now (machine away, project removed) is not drawn, and is kept.
// Everything survives a restart; only a saved copy of another shape resets it, to Chats.
const WorkspaceTabsState = Schema.Struct({
  // Changed only by the setting.
  mode: Schema.Literals(["chats", "workspaces"]),
  // Set by showing a chat or picking a workspace; closing the last tab clears it.
  activeKey: Schema.NullOr(Schema.String),
  entries: Schema.Array(WorkspaceEntry),
});
export type WorkspaceTabsState = typeof WorkspaceTabsState.Type;
export type TabsMode = WorkspaceTabsState["mode"];

export const EMPTY_WORKSPACE_TABS: WorkspaceTabsState = {
  mode: "chats",
  activeKey: null,
  entries: [],
};

/** What identifies a listed workspace: its key now, and its projects' stable physical keys. */
export interface WorkspaceIdentity {
  readonly key: string;
  readonly members: ReadonlyArray<string>;
}

const shares = (a: WorkspaceIdentity, b: WorkspaceIdentity) =>
  a.members.some((member) => b.members.includes(member));

/**
 * The listed workspace an entry stands for. A project's group key changes when its repository
 * becomes known or the grouping setting changes; its folders still name it.
 */
function workspaceOfEntry<T extends WorkspaceIdentity>(
  entry: WorkspaceIdentity,
  workspaces: ReadonlyArray<T>,
): T | null {
  return (
    workspaces.find((workspace) => workspace.key === entry.key) ??
    workspaces.find((workspace) => shares(entry, workspace)) ??
    null
  );
}

/** The open tabs to draw, in order, one per listed workspace. */
export function openTabs<T extends WorkspaceIdentity>(
  state: WorkspaceTabsState,
  workspaces: ReadonlyArray<T>,
): Array<{ readonly entry: WorkspaceEntry; readonly workspace: T }> {
  const drawn = new Set<string>();
  return state.entries.flatMap((entry) => {
    if (!entry.open) return [];
    const workspace = workspaceOfEntry(entry, workspaces);
    if (workspace === null || drawn.has(workspace.key)) return [];
    drawn.add(workspace.key);
    return [{ entry, workspace }];
  });
}

/**
 * The workspace whose chats the sidebar lists: the active one, or, when the workspace switcher
 * hides it, the most recently visited open tab the switcher still shows. Null lists everything.
 */
export function shownWorkspace<T extends WorkspaceIdentity>(
  state: WorkspaceTabsState,
  workspaces: ReadonlyArray<T>,
  visible: (workspace: T) => boolean,
): T | null {
  const candidates = openTabs(state, workspaces).filter((tab) => visible(tab.workspace));
  const active = candidates.find((tab) => tab.entry.key === state.activeKey);
  if (active !== undefined) return active.workspace;
  const recent = candidates.toSorted((a, b) => b.entry.visitedAt - a.entry.visitedAt)[0];
  return recent?.workspace ?? null;
}

const entryFor = (state: WorkspaceTabsState, workspace: WorkspaceIdentity) =>
  state.entries.find((entry) => entry.key === workspace.key) ??
  state.entries.find((entry) => shares(entry, workspace));

/**
 * Writes the workspace's entry. `change` gets the saved one, or a closed blank. A tab that opens
 * goes to the end. Entries that now stand for the same workspace (groups merged) fold into it,
 * and a chat that moved to this workspace is no other's last chat.
 */
function writeEntry(
  state: WorkspaceTabsState,
  workspace: WorkspaceIdentity,
  change: (entry: WorkspaceEntry) => WorkspaceEntry,
): WorkspaceTabsState {
  const saved = entryFor(state, workspace);
  const blank: WorkspaceEntry = {
    key: workspace.key,
    members: workspace.members,
    open: false,
    pinned: false,
    visitedAt: 0,
    lastChat: null,
  };
  const next = change({ ...(saved ?? blank), key: workspace.key, members: workspace.members });
  const opening = next.open && saved?.open !== true;
  const entries = state.entries.flatMap((entry) => {
    if (entry === saved) return opening ? [] : [next];
    if (entry.key === workspace.key || shares(entry, workspace)) return [];
    return next.lastChat !== null && entry.lastChat?.href === next.lastChat.href
      ? [{ ...entry, lastChat: null }]
      : [entry];
  });
  if (saved === undefined || opening) entries.push(next);
  return {
    ...state,
    entries,
    activeKey: saved && state.activeKey === saved.key ? next.key : state.activeKey,
  };
}

/** The workspace is now in front: its tab opens, and `chat`, when given, is its last chat. */
export function visitWorkspace(
  state: WorkspaceTabsState,
  workspace: WorkspaceIdentity,
  chat: WorkspaceChat | null,
  now: number,
): WorkspaceTabsState {
  const written = writeEntry(state, workspace, (entry) => ({
    ...entry,
    open: true,
    visitedAt: now,
    lastChat: chat ?? entry.lastChat,
  }));
  return { ...written, activeKey: workspace.key };
}

/**
 * Switching to workspaces: each open chat's project gets a tab, in the chats' order, with that
 * project's most recently used chat. A tab the user closed stays closed.
 */
export function seedWorkspaces(
  state: WorkspaceTabsState,
  chats: ReadonlyArray<{
    readonly workspace: WorkspaceIdentity;
    readonly chat: WorkspaceChat;
    readonly at: number;
  }>,
): WorkspaceTabsState {
  return chats.reduce(
    (current, { workspace, chat, at }) =>
      writeEntry(current, workspace, (entry) => {
        const isNew = entryFor(current, workspace) === undefined;
        const newer = entry.lastChat === null || at > entry.visitedAt;
        return {
          ...entry,
          open: isNew || entry.open,
          visitedAt: newer ? at : entry.visitedAt,
          lastChat: newer ? chat : entry.lastChat,
        };
      }),
    state,
  );
}

/**
 * Hides tabs; each keeps its last chat. `drawn` is the tab order on screen and `shown` the selected
 * tab. When that one goes, `next` is the tab to show instead: the right neighbour, then the left
 * one, or null when none is left.
 */
export function hideWorkspaces(
  state: WorkspaceTabsState,
  keys: ReadonlySet<string>,
  drawn: ReadonlyArray<string>,
  shown: string | null,
): { state: WorkspaceTabsState; closedShown: boolean; next: string | null } {
  const entries = state.entries.map((entry) =>
    keys.has(entry.key) && entry.open ? { ...entry, open: false, pinned: false } : entry,
  );
  const closedShown = shown !== null && keys.has(shown);
  if (!closedShown) {
    return { state: { ...state, entries }, closedShown, next: null };
  }
  const index = drawn.indexOf(shown);
  const stays = (key: string) => !keys.has(key);
  const next =
    drawn.slice(index + 1).find(stays) ?? drawn.slice(0, index).toReversed().find(stays) ?? null;
  return { state: { ...state, entries, activeKey: next }, closedShown, next };
}

export function toggleWorkspacePin(state: WorkspaceTabsState, key: string): WorkspaceTabsState {
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.key === key ? { ...entry, pinned: !entry.pinned } : entry,
    ),
  };
}

export function moveWorkspace(
  state: WorkspaceTabsState,
  key: string,
  beforeKey: string | null,
): WorkspaceTabsState {
  const moving = state.entries.find((entry) => entry.key === key);
  if (moving === undefined || key === beforeKey) return state;
  const rest = state.entries.filter((entry) => entry !== moving);
  const index = beforeKey === null ? -1 : rest.findIndex((entry) => entry.key === beforeKey);
  const entries = index === -1 ? [...rest, moving] : rest.toSpliced(index, 0, moving);
  return { ...state, entries };
}

/** The entry's last chat is gone for good (deleted or archived). */
export function forgetLastChat(state: WorkspaceTabsState, key: string): WorkspaceTabsState {
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.key === key && entry.lastChat !== null ? { ...entry, lastChat: null } : entry,
    ),
  };
}

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(WorkspaceTabsState));

/** The saved object, or null when it is missing or of another shape (the caller wipes it). */
export function parseWorkspaceTabs(raw: string | null): WorkspaceTabsState | null {
  if (raw === null) return null;
  const decoded = decodeState(raw);
  if (decoded._tag === "None") return null;
  const state = decoded.value;
  if (new Set(state.entries.map((entry) => entry.key)).size !== state.entries.length) return null;
  if (state.entries.some((entry) => entry.pinned && !entry.open)) return null;
  return state;
}
