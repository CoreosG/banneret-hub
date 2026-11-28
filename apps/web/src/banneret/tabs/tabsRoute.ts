// Banneret Hub: what the router shows, as a tab target, and the router subscription that feeds the
// tabs store. Reads current state on each resolved navigation or workspace switch; nothing polls.
import type { AnyRouter } from "@tanstack/react-router";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { isAppModalPage } from "../../components/sidebar/mainAppLocation";
import { readThreadShell } from "../../state/entities";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { resolveWorkspaces } from "../workspaces.logic";
import { useWorkspacesStore } from "../workspacesStore";
import {
  isPagePath,
  pageTitle,
  tabKey,
  targetKey,
  type TabTarget,
  type TabThreadRef,
} from "./tabs.logic";
import { closeInactive, keep, observeRoute, useTabsStore } from "./tabsStore";
import { useWorkspaceTabsStore } from "./workspaceTabsStore";

/** "modal": Settings and Usage open over the last view, which keeps its tab. */
function readRouteTarget(router: AnyRouter): TabTarget | null | "modal" {
  const { pathname, searchStr } = router.state.location;
  if (isAppModalPage(pathname)) return "modal";
  if (pathname.startsWith("/channels/"))
    return {
      kind: "chat",
      href: pathname + searchStr,
      workspaceId: useWorkspacesStore.getState().activeId,
      title: "Channel",
    };
  if (isPagePath(pathname)) {
    return {
      kind: "page",
      // The search keeps a page's filters (Board, Map, Feed) when its tab is opened again.
      href: `${pathname}${searchStr}`,
      workspaceId: useWorkspacesStore.getState().activeId,
      title: pageTitle(pathname),
    };
  }
  const params = (router.state.matches.at(-1)?.params ?? {}) as Record<string, string | undefined>;
  if (params.linkedEnvironmentId !== undefined && params.linkedThreadId !== undefined) {
    return {
      kind: "thread",
      href: pathname,
      threadRef: { environmentId: params.linkedEnvironmentId, threadId: params.linkedThreadId },
      title: "Linked thread",
      draft: false,
    };
  }
  const target = resolveThreadRouteTarget(params);
  if (target === null) return null;
  const drafts = useComposerDraftStore.getState();
  if (target.kind === "draft") {
    const session = drafts.getDraftSession(target.draftId);
    return {
      kind: "thread",
      href: pathname,
      threadRef:
        session === null
          ? null
          : { environmentId: session.environmentId, threadId: session.threadId },
      title: "New thread",
      draft: true,
    };
  }
  const threadRef: TabThreadRef = {
    environmentId: target.threadRef.environmentId,
    threadId: target.threadRef.threadId,
  };
  return {
    kind: "thread",
    href: pathname,
    threadRef,
    title: readThreadShell(target.threadRef)?.title ?? "Thread",
    draft: false,
    promotedFrom: promotedFromActiveDraft(threadRef),
  };
}

/** The active tab's key when it is the draft that was just sent as `threadRef`. */
function promotedFromActiveDraft(threadRef: TabThreadRef): string | undefined {
  const { tabs, activeId } = useTabsStore.getState();
  const active = tabs.find((tab) => tab.id === activeId);
  if (active === undefined || !active.href.startsWith("/draft/")) return undefined;
  const draftId = DraftId.make(active.href.slice("/draft/".length));
  const drafts = useComposerDraftStore.getState();
  const promotedTo =
    drafts.getPromotedDraftRedirect(draftId) ?? drafts.getDraftSession(draftId)?.promotedTo ?? null;
  if (promotedTo === null) return undefined;
  const same =
    promotedTo.environmentId === threadRef.environmentId &&
    promotedTo.threadId === threadRef.threadId;
  if (!same) return undefined;
  return tabKey(active);
}

/** The last view under any modal; undefined until the router has shown one. */
let shownTarget: TabTarget | null | undefined;

export const shownRouteTarget = () => shownTarget;

export function syncTabsWithRoute(router: AnyRouter) {
  const target = readRouteTarget(router);
  if (target === "modal") return;
  shownTarget = target;
  // With Workspaces tabs the chats tabs stay exactly as they were left.
  if (useWorkspaceTabsStore.getState().mode === "chats") observeRoute(target);
}

/**
 * Back from Workspaces tabs: the view in front gets its chats tab. A preview that would make way for
 * it is kept, so no tab is lost by switching.
 */
export function resumeChatTabs() {
  if (shownTarget === undefined) return;
  if (shownTarget !== null) {
    const key = targetKey(shownTarget);
    const { tabs } = useTabsStore.getState();
    const preview = tabs.find((tab) => !tab.kept);
    if (preview !== undefined && !tabs.some((tab) => tabKey(tab) === key)) keep(preview.id);
  }
  observeRoute(shownTarget);
}

/**
 * A workspace listed earlier in this session and gone from the list since was deleted: its inactive
 * page tabs close. A list that failed to load (empty) never closes a workspace it never listed.
 */
function workspacePruner() {
  const listed = new Set<string>();
  const gone = new Set<string>();
  return () => {
    const { local, byEnvironment } = useWorkspacesStore.getState();
    const live = new Set(
      resolveWorkspaces(local, ...Object.values(byEnvironment)).map((w) => w.id),
    );
    for (const id of live) {
      listed.add(id);
      gone.delete(id);
    }
    for (const id of listed) if (!live.has(id)) gone.add(id);
    if (gone.size > 0)
      closeInactive((tab) => tab.workspaceId !== null && gone.has(tab.workspaceId));
  };
}

/** Feeds the store from the router and from manual workspace switches (a page tab per workspace). */
export function subscribeTabsToRoute(router: AnyRouter): () => void {
  const pruneWorkspaces = workspacePruner();
  syncTabsWithRoute(router);
  pruneWorkspaces();
  const stopRouter = router.subscribe("onResolved", () => syncTabsWithRoute(router));
  const stopWorkspaces = useWorkspacesStore.subscribe((state, previous) => {
    if (state.activeId !== previous.activeId) syncTabsWithRoute(router);
    if (state.byEnvironment !== previous.byEnvironment || state.local !== previous.local) {
      pruneWorkspaces();
    }
  });
  const stopTabs = useTabsStore.subscribe((state, previous) => {
    if (state.activeId !== previous.activeId) pruneWorkspaces();
  });
  return () => {
    stopRouter();
    stopWorkspaces();
    stopTabs();
  };
}
