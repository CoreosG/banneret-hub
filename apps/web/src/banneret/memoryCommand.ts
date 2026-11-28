import type { ChatComposerProps } from "../components/chat/ChatComposer";
import { useComposerDraftStore } from "../composerDraftStore";
import { workflowAction } from "./WorkflowReview";
import { toastManager } from "../components/ui/toast";
import { create } from "zustand";
import type { ScopedThreadRef } from "@t3tools/contracts";
export const memoryThreadKey = (ref: ScopedThreadRef) =>
  JSON.stringify([ref.environmentId, ref.threadId]);
export const useMemoryCard = create<{ open: Record<string, string> }>(() => ({ open: {} }));
export const useMemoryAvailability = create<{ threads: Record<string, boolean> }>(() => ({
  threads: {},
}));

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
  if (/^review my workflow[.!?]?$/i.test(prompt.trim())) {
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
