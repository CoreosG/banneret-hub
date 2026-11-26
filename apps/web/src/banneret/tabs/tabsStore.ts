// Banneret Hub: the open tabs, saved on this device under one localStorage key. A saved copy of
// another shape is wiped, never migrated.
//
// Activating a page tab switches the workspace and then navigates. In between, the router still
// shows the old route under the new workspace, which must not count as a navigation. So the store
// is either following the router or `activating` one tab:
//
// | Mode       | Enters when                 | Leaves when                                        |
// |------------|-----------------------------|----------------------------------------------------|
// | following  | start; activation settles   | a tab is activated                                 |
// | activating | activateTab                 | the router shows that tab, or its navigation ends  |
//
// While activating, route observations other than the target are ignored. `activating` is in
// memory only; a reload starts in following.
import { create } from "zustand";

import {
  closeTabs,
  EMPTY_TABS,
  keepTab,
  moveTab,
  observeTarget,
  parseTabsState,
  setTabTitle,
  tabKey,
  TABS_STORAGE_KEY,
  targetKey,
  togglePin,
  type Tab,
  type TabsState,
  type TabTarget,
} from "./tabs.logic";

interface TabsStore extends TabsState {
  /** The key of the tab being activated, or null while following the router. */
  readonly activating: string | null;
}

function readSaved(): TabsState {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    const parsed = parseTabsState(raw);
    if (parsed === null && raw !== null) localStorage.removeItem(TABS_STORAGE_KEY);
    return parsed ?? EMPTY_TABS;
  } catch {
    return EMPTY_TABS;
  }
}

function save(state: TabsState) {
  try {
    const { tabs, activeId, hidden } = state;
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs, activeId, hidden }));
  } catch {
    // Private windows keep working, just without remembering.
  }
}

export const useTabsStore = create<TabsStore>(() => ({ ...readSaved(), activating: null }));

function update(change: (state: TabsState) => TabsState) {
  const current = useTabsStore.getState();
  const next = change(current);
  if (next === current) return;
  useTabsStore.setState(next);
  save(next);
}

const newTabId = () => crypto.randomUUID();

/** The router now shows `target`. Ignored while another tab is being activated. */
export function observeRoute(target: TabTarget | null) {
  const { activating } = useTabsStore.getState();
  if (activating !== null) {
    if (target === null || targetKey(target) !== activating) return;
    useTabsStore.setState({ activating: null });
  }
  update((state) => observeTarget(state, target, Date.now(), newTabId));
}

export function beginActivation(tab: Tab) {
  useTabsStore.setState({ activating: tabKey(tab) });
}

/** The activation's navigation ended (shown, redirected or failed): follow the router again. */
export function endActivation() {
  useTabsStore.setState({ activating: null });
}

export const keep = (id: string) => update((state) => keepTab(state, id));
export const pin = (id: string) => update((state) => togglePin(state, id));
export const retitle = (id: string, title: string) =>
  update((state) => setTabTitle(state, id, title));
export const move = (id: string, beforeId: string | null) =>
  update((state) => moveTab(state, id, beforeId));
export const setTabsHidden = (hidden: boolean) =>
  update((state) => (state.hidden === hidden ? state : { ...state, hidden }));

/** Closes tabs; returns the tab to show when the active one closed (null: go home). */
export function close(ids: ReadonlySet<string>): { closedActive: boolean; next: Tab | null } {
  let result = { closedActive: false, next: null as Tab | null };
  update((state) => {
    const closed = closeTabs(state, ids);
    result = { closedActive: closed.closedActive, next: closed.next };
    return closed.state;
  });
  return result;
}

/** Tests only: start over from what localStorage holds now. */
export function __reloadTabsForTests() {
  useTabsStore.setState({ ...readSaved(), activating: null }, true);
}
