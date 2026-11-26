// Banneret Hub: what the router shows, as a tab target, and the router subscription that feeds the
// tabs store. Reads current state on each resolved navigation or workspace switch; nothing polls.
import type { AnyRouter } from "@tanstack/react-router";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { isAppModalPage } from "../../components/sidebar/mainAppLocation";
import { readThreadShell } from "../../state/entities";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useWorkspacesStore } from "../workspacesStore";
import { isPagePath, pageTitle, tabKey, type TabTarget, type TabThreadRef } from "./tabs.logic";
import { observeRoute, useTabsStore } from "./tabsStore";

/** "modal": Settings and Usage open over the last view, which keeps its tab. */
function readRouteTarget(router: AnyRouter): TabTarget | null | "modal" {
  const { pathname } = router.state.location;
  if (isAppModalPage(pathname)) return "modal";
  if (isPagePath(pathname)) {
    return {
      kind: "page",
      href: pathname,
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

export function syncTabsWithRoute(router: AnyRouter) {
  const target = readRouteTarget(router);
  if (target !== "modal") observeRoute(target);
}

/** Feeds the store from the router and from manual workspace switches (a page tab per workspace). */
export function subscribeTabsToRoute(router: AnyRouter): () => void {
  syncTabsWithRoute(router);
  const stopRouter = router.subscribe("onResolved", () => syncTabsWithRoute(router));
  const stopWorkspaces = useWorkspacesStore.subscribe((state, previous) => {
    if (state.activeId !== previous.activeId) syncTabsWithRoute(router);
  });
  return () => {
    stopRouter();
    stopWorkspaces();
  };
}
