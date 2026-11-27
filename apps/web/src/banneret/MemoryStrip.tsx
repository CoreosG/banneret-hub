import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type MemoryReviewNote,
  type MemoryReviewAction,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useChatRead } from "./chat/client";
import { useOrchestrators } from "./orchestratorStore";
import { relayKey } from "./enrolmentStore";
import { type ReactNode, useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { MemoryTransfer } from "./MemoryTransfer";
import {
  useMemoryAvailability,
  memoryThreadKey,
  useMemoryCard,
  memoryCardQuery,
  setMemoryCard,
} from "./memoryCommand";
import { MemoryNotes } from "./MemoryReview";
const list = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:memory-list",
  tag: "memory.list",
});
const review = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:memory-review",
  tag: "memory.review",
});
const confirm = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:confirm-import",
  tag: "memory.confirmImport",
});
const summary = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:memory-summary",
  tag: "memory.summary",
});

export function MemoryStrip({
  environmentId,
  threadId,
  renderTimeline,
  working,
}: ScopedThreadRef & { renderTimeline?: (cards: ReactNode) => ReactNode; working?: boolean }) {
  const allowed = useAtomValue(summary.permissionAtom(environmentId));
  const [expanded, setExpanded] = useState(false);
  const writable = useAtomValue(review.permissionAtom(environmentId));
  const prefix = relayKey({ environmentId, relayOrigin: "" });
  const designated = useOrchestrators((state) =>
    Object.entries(state.byRelay).some(
      ([k, v]) =>
        k.startsWith(prefix) &&
        (v.main === threadId || Object.values(v.projects).includes(threadId)),
    ),
  );
  const [revision, refresh] = useState(0);
  const state = useChatRead(async () => {
    if (!allowed) return null;
    const result = await runAtomCommand(appAtomRegistry, summary, {
      environmentId,
      input: { threadId },
    });
    return result._tag === "Success" ? result.value : null;
  }, [environmentId, threadId, allowed, designated, revision, working].join(":"));
  const counts = state.value;
  const resolved = counts !== undefined;
  const visible = allowed && counts != null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- other chats can change these server counts while this thread is idle
  useEffect(() => {
    if (!visible) return;
    const tick = () => {
      if (document.visibilityState === "visible") refresh((n) => n + 1);
    };
    const timer = window.setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [visible]);
  const ref = { environmentId, threadId };
  const query = useMemoryCard(memoryCardQuery(ref));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publish this mounted timeline's server authorization to its composer
  useEffect(() => {
    if (!resolved || !allowed) return;
    const key = memoryThreadKey({ environmentId, threadId });
    useMemoryAvailability.setState((state) => ({ threads: { ...state.threads, [key]: visible } }));
    return () =>
      useMemoryAvailability.setState((state) => {
        const threads = { ...state.threads };
        delete threads[key];
        return { threads };
      });
  }, [allowed, resolved, visible, environmentId, threadId]);
  const loadNotes =
    visible && (query !== undefined || expanded || counts.proposed + counts.disputed > 0);
  const notes = useChatRead(
    async () => {
      if (!loadNotes) return [];
      const result = await runAtomCommand(appAtomRegistry, list, {
        environmentId,
        input: { threadId, pendingOnly: !expanded && query === undefined },
      });
      if (result._tag !== "Success") throw new Error("Could not load notes.");
      return result.value;
    },
    [loadNotes, query !== undefined, expanded, revision, environmentId, threadId, working].join(
      ":",
    ),
  );
  async function apply(note: MemoryReviewNote, action: MemoryReviewAction) {
    const result = await runAtomCommand(appAtomRegistry, review, {
      environmentId,
      input: { threadId, key: note.key, version: note.version, action },
    });
    refresh((n) => n + 1);
    if (result._tag !== "Success") throw new Error("Could not save note.");
  }
  const confirmBatch = async (batch: string, pending: readonly MemoryReviewNote[]) => {
    const result = await runAtomCommand(appAtomRegistry, confirm, {
      environmentId,
      input: { threadId, batch, notes: pending.map(({ key, version }) => ({ key, version })) },
    });
    refresh((n) => n + 1);
    if (result._tag !== "Success") throw new Error("Import batch changed.");
  };
  const cards =
    visible && query !== undefined ? (
      <section aria-label="Memory command" className="chat-content-lane rounded border p-3">
        <div className="flex justify-between">
          <strong>Memory</strong>
          <button onClick={() => setMemoryCard(ref)}>Close</button>
        </div>
        <label>
          Search notes{" "}
          <input type="search" value={query} onChange={(e) => setMemoryCard(ref, e.target.value)} />
        </label>
        {writable && (
          <MemoryTransfer {...ref} revision={revision} refresh={() => refresh((n) => n + 1)} />
        )}
        {notes.error && <p role="alert">{notes.error}</p>}
        {notes.value && (
          <MemoryNotes
            expanded
            confirmBatch={confirmBatch}
            notes={notes.value.filter((n) =>
              (n.key + " " + n.text).toLowerCase().includes(query.toLowerCase()),
            )}
            writable={writable}
            apply={apply}
          />
        )}
      </section>
    ) : loadNotes && notes.value?.some((n) => n.trust === "disputed" || n.trust === "proposed") ? (
      <div className="chat-content-lane">
        <MemoryNotes notes={notes.value} expanded={false} writable={writable} apply={apply} />
      </div>
    ) : null;
  return (
    <>
      {visible && (
        <section className="shrink-0 border-b">
          <button
            type="button"
            className="flex w-full flex-wrap items-center gap-x-2 px-4 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <span aria-hidden>{expanded ? "▾" : "▸"}</span>
            <strong>Memory</strong>
            <span>
              {counts.total} notes · {counts.proposed} proposed · {counts.disputed} disputed
            </span>
            <span>Stored unencrypted on this machine</span>
          </button>
          {loadNotes && notes.error && <p role="alert">{notes.error}</p>}
          {expanded && notes.value && (
            <MemoryNotes expanded notes={notes.value} writable={writable} apply={apply} />
          )}
        </section>
      )}
      {renderTimeline ? renderTimeline(cards) : cards}
    </>
  );
}
