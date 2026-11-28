// Banneret Hub: what a tab's clicks and menu do to the router and the tabs store.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { setActiveWorkspace } from "../workspacesStore";
import type { Tab } from "./tabs.logic";
import { syncTabsWithRoute } from "./tabsRoute";
import { beginActivation, close, endActivation, useTabsStore } from "./tabsStore";

/** Shows a tab: a page tab switches its workspace first; a thread tab's workspace follows itself. */
export async function activateTab(router: AnyRouter, tab: Tab) {
  if (tab.kind === "thread") {
    await router.navigate({ href: tab.href });
    return;
  }
  beginActivation(tab);
  try {
    setActiveWorkspace(tab.workspaceId);
    await router.navigate({ href: tab.href });
  } finally {
    endActivation();
    syncTabsWithRoute(router);
  }
}

/**
 * Closes tabs. When the active one is among them, `instead` is shown in its place if given,
 * otherwise a neighbour, or home when none is left.
 */
export async function closeAndShow(router: AnyRouter, ids: ReadonlySet<string>, instead?: Tab) {
  const { activeId } = useTabsStore.getState();
  if (instead !== undefined && activeId !== null && ids.has(activeId)) {
    await activateTab(router, instead);
    // The store must show the new active tab before the old one closes.
    syncTabsWithRoute(router);
  }
  const { closedActive, next } = close(ids);
  if (!closedActive) return;
  if (next === null) await router.navigate({ to: "/" });
  else await activateTab(router, next);
}

export const closeTab = (router: AnyRouter, id: string) => closeAndShow(router, new Set([id]));

export function toScopedRef(tab: Pick<Tab, "threadRef">): ScopedThreadRef | null {
  return tab.threadRef === null
    ? null
    : scopeThreadRef(
        EnvironmentId.make(tab.threadRef.environmentId),
        ThreadId.make(tab.threadRef.threadId),
      );
}
