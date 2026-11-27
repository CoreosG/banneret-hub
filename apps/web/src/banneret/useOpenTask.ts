// Banneret Hub: every way into the Task tab (Board cards, Feed and Graveyard entries). With a thread or
// draft routed, the task opens as a `task` tab in that view's right panel; Board, Feed and Today are
// pages with no thread, so there it opens in the Task dialog, as Ports does without a thread.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BanneretBoardTask, ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { useRightPanelStore } from "../rightPanelStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { RelayTarget } from "./enrolmentStore";
import { openTaskDialog } from "./taskStore";
import { taskSurface } from "./taskSurface";

/** The routed thread's or draft's right panel; null on a page with neither. */
function useRoutedPanelRef(): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(useParams({ strict: false }));
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  if (target?.kind === "server") return target.threadRef;
  return draft === null ? null : scopeThreadRef(draft.environmentId, draft.threadId);
}

/** Opens a task of `target`'s relay; does nothing without one (no company joined here). */
export function useOpenTask(target: RelayTarget | null): (task: BanneretBoardTask) => void {
  const panelRef = useRoutedPanelRef();
  return (task) => {
    if (target === null) return;
    const surface = taskSurface(target, task);
    if (panelRef === null) openTaskDialog(surface);
    else useRightPanelStore.getState().openTask(panelRef, surface);
  };
}
