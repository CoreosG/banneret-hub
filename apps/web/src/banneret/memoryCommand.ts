import type { ChatComposerProps } from "../components/chat/ChatComposer";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  isWorkflowPhrase,
  WORKFLOW_HINT,
  workflowAction,
  workflowReviewOffered,
} from "./WorkflowReview";
import { toastManager } from "../components/ui/toast";
import { create } from "zustand";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { relayKey } from "./enrolmentStore";
import { useOrchestrators } from "./orchestratorStore";
export const memoryThreadKey = (ref: ScopedThreadRef) =>
  JSON.stringify([ref.environmentId, ref.threadId]);
export const useMemoryCard = create<{ open: Record<string, string> }>(() => ({ open: {} }));
/** `threads`: the chat has memory commands. `mains`: it is also the main orchestrator chat. */
export const useMemoryAvailability = create<{
  threads: Record<string, boolean>;
  mains: Record<string, boolean>;
}>(() => ({
  threads: {},
  mains: {},
}));
/** The chat's memory summary decides. Until it arrives, the designation list answers. */
function isMainChat(ref: ScopedThreadRef) {
  const summary = useMemoryAvailability.getState().mains[memoryThreadKey(ref)];
  if (summary !== undefined) return summary;
  const prefix = relayKey({ environmentId: ref.environmentId, relayOrigin: "" });
  return Object.entries(useOrchestrators.getState().byRelay).some(
    ([key, roles]) => key.startsWith(prefix) && roles.main === ref.threadId,
  );
}

export function setMemoryCard(ref: ScopedThreadRef, query?: string) {
  useMemoryCard.setState((state) => {
    const open = { ...state.open };
    if (query === undefined) delete open[memoryThreadKey(ref)];
    else open[memoryThreadKey(ref)] = query;
    return { open };
  });
}
export const memoryCardQuery =
  (ref: ScopedThreadRef) => (state: ReturnType<typeof useMemoryCard.getState>) =>
    state.open[memoryThreadKey(ref)];

export function openMemoryCommand(
  {
    routeThreadRef,
    composerDraftTarget,
    promptRef,
    composerRef,
  }: Pick<
    ChatComposerProps,
    "routeThreadRef" | "composerDraftTarget" | "promptRef" | "composerRef"
  >,
  prompt: string,
  detached = false,
) {
  const match = /^\/memory(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  if (isWorkflowPhrase(prompt)) {
    if (!isMainChat(routeThreadRef)) {
      // The message still goes to the agent.
      if (workflowReviewOffered(routeThreadRef.environmentId))
        toastManager.add({ type: "info", ...WORKFLOW_HINT });
      return false;
    }
    void workflowAction(routeThreadRef, "run").catch(() =>
      toastManager.add({
        type: "error",
        title: "Run workflow review in your private main orchestrator chat.",
      }),
    );
  } else if (match) setMemoryCard(routeThreadRef, match[1]?.trim() ?? "");
  else return false;
  const store = useComposerDraftStore.getState();
  if (store.getComposerDraft(composerDraftTarget)?.prompt === prompt)
    store.setPrompt(composerDraftTarget, "");
  if (!detached && promptRef.current === prompt) {
    promptRef.current = "";
    composerRef.current?.resetCursorState();
  }
  return true;
}
