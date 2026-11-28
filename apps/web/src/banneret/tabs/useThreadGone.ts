// Banneret Hub: whether a tab's thread is gone: the shell marks it deleted or archived, or it left
// the shell while this window watched and its environment stayed live. A thread the shell never
// listed (older settled, idle subagents, linked threads) is not; its own route shows what happened.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { environmentShell } from "../../state/shell";

const NO_ENVIRONMENT = EnvironmentId.make("none");

export function useThreadGone(
  threadRef: ScopedThreadRef | null,
  shell: EnvironmentThreadShell | null,
): boolean {
  const live =
    useAtomValue(environmentShell.stateValueAtom(threadRef?.environmentId ?? NO_ENVIRONMENT))
      .status === "live";
  const hasDraft = useComposerDraftStore(
    (store) => threadRef !== null && store.getDraftSessionByRef(threadRef) !== null,
  );
  // Whether this window saw the thread in a live shell since the environment last went live.
  const [seen, setSeen] = useState(false);
  const seenNow = live && (shell !== null || seen);
  if (seenNow !== seen) setSeen(seenNow);
  if (threadRef === null || hasDraft) return false;
  return shell !== null ? shell.deletedAt !== null || shell.archivedAt !== null : live && seen;
}
