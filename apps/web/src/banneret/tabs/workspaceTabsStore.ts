// Banneret Hub: the "Tabs show" setting and the workspace tabs, saved on this device under their
// own localStorage key. Nothing saved means Chats. A saved copy of another shape is wiped.
import { create } from "zustand";

import {
  EMPTY_WORKSPACE_TABS,
  forgetLastChat,
  hideWorkspaces,
  moveWorkspace,
  parseWorkspaceTabs,
  seedWorkspaces,
  toggleWorkspacePin,
  visitWorkspace,
  WORKSPACE_TABS_STORAGE_KEY,
  type TabsMode,
  type WorkspaceChat,
  type WorkspaceIdentity,
  type WorkspaceTabsState,
} from "./workspaceTabs.logic";

function readSaved(): WorkspaceTabsState {
  try {
    const raw = localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY);
    const parsed = parseWorkspaceTabs(raw);
    if (parsed === null && raw !== null) localStorage.removeItem(WORKSPACE_TABS_STORAGE_KEY);
    return parsed ?? EMPTY_WORKSPACE_TABS;
  } catch {
    return EMPTY_WORKSPACE_TABS;
  }
}

export const useWorkspaceTabsStore = create<WorkspaceTabsState>(() => readSaved());

function update(change: (state: WorkspaceTabsState) => WorkspaceTabsState) {
  const current = useWorkspaceTabsStore.getState();
  const next = change(current);
  if (next === current) return;
  useWorkspaceTabsStore.setState(next);
  try {
    localStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private windows keep working, just without remembering.
  }
}

export const setSavedTabsMode = (mode: TabsMode) =>
  update((state) => (state.mode === mode ? state : { ...state, mode }));
export const visit = (workspace: WorkspaceIdentity, chat: WorkspaceChat | null) =>
  update((state) => visitWorkspace(state, workspace, chat, Date.now()));
export const seed = (chats: Parameters<typeof seedWorkspaces>[1]) =>
  update((state) => seedWorkspaces(state, chats));
export const pinWorkspace = (key: string) => update((state) => toggleWorkspacePin(state, key));
export const moveWorkspaceTab = (key: string, beforeKey: string | null) =>
  update((state) => moveWorkspace(state, key, beforeKey));
export const forgetChat = (key: string) => update((state) => forgetLastChat(state, key));

export function hide(
  keys: ReadonlySet<string>,
  drawn: ReadonlyArray<string>,
  shown: string | null,
): { closedShown: boolean; next: string | null } {
  let result = { closedShown: false, next: null as string | null };
  update((state) => {
    const hidden = hideWorkspaces(state, keys, drawn, shown);
    result = { closedShown: hidden.closedShown, next: hidden.next };
    return hidden.state;
  });
  return result;
}

/** Tests only: start over from what localStorage holds now. */
export function __reloadWorkspaceTabsForTests() {
  useWorkspaceTabsStore.setState(readSaved(), true);
}
