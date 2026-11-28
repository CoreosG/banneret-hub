import { WorkflowReview, workflowAction } from "./WorkflowReview";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { MemoryContradictionCard } from "./MemoryContradictionCard";
import { countLabel } from "./countLabel";
import { MemoryPreferences } from "./MemoryPreferences";
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
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import {
  useMemoryAvailability,
  memoryThreadKey,
  useMemoryCard,
  memoryCardQuery,
  setMemoryCard,
} from "./memoryCommand";
import { MemoryNotes } from "./MemoryReview";
const skills = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:memory-skills",
  tag: "memory.skills",
});
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

/** Your notes stay readable here when the company's memory is somewhere else. */
function MemoryOwnerLine() {
  const enterprise = useEnterpriseFeed();
  const owner = enterprise?.feed.elsewhere?.memory;
  return owner ? (
    <p className="px-4 pb-1 text-xs">
      {owner.owner === "external"
        ? `Memory is managed by ${owner.title}.`
        : `Memory is turned off at ${enterprise.workspace.name}.`}{" "}
      Agents here do not get these notes. Your own notes stay on this machine.
    </p>
  ) : null;
}

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
  const visible = allowed && counts != null && !counts.cardsOnly;
  // The server refuses a review when the company's memory belongs elsewhere.
  const memoryElsewhere = useEnterpriseFeed()?.feed.elsewhere?.memory !== undefined;
  const main = visible && Boolean(counts.main) && !memoryElsewhere;
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
  const catalog = useChatRead(
    async () => {
      if (!visible || query !== "skills") return [];
      const result = await runAtomCommand(appAtomRegistry, skills, {
        environmentId,
        input: { threadId },
      });
      if (result._tag !== "Success") throw new Error("Could not load skills.");
      return result.value;
    },
    [visible, query === "skills", revision, environmentId, threadId].join(":"),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publish this mounted timeline's server authorization to its composer
  useEffect(() => {
    if (!resolved || !allowed) return;
    const key = memoryThreadKey({ environmentId, threadId });
    useMemoryAvailability.setState((state) => ({
      threads: { ...state.threads, [key]: visible },
      mains: { ...state.mains, [key]: main },
    }));
    return () =>
      useMemoryAvailability.setState((state) => {
        const threads = { ...state.threads };
        const mains = { ...state.mains };
        delete threads[key];
        delete mains[key];
        return { threads, mains };
      });
  }, [allowed, resolved, visible, main, environmentId, threadId]);
  const [reviewing, setReviewing] = useState(false);
  const loadNotes =
    (allowed && counts?.cardsOnly) ||
    (visible && (query !== undefined || expanded || counts.proposed + counts.disputed > 0));
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
  async function apply(
    note: Pick<MemoryReviewNote, "key" | "version">,
    action: MemoryReviewAction,
  ) {
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
  const reviewCards =
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
        {query === "skills" && (
          <>
            <strong>Effective skills</strong>
            {catalog.error && <p role="alert">{catalog.error}</p>}
            {catalog.value?.map((skill) => (
              <p key={skill.name}>
                {skill.name} · {skill.layer} · {skill.trust}
                {skill.locked && " · Locked by the company"}
                <br />
                {skill.description}
              </p>
            ))}
          </>
        )}
        {writable && (
          <MemoryTransfer {...ref} revision={revision} refresh={() => refresh((n) => n + 1)} />
        )}
        {notes.error && <p role="alert">{notes.error}</p>}
        {notes.value && (
          <MemoryNotes
            expanded
            confirmBatch={confirmBatch}
            lockedSkills={(catalog.value ?? []).filter((s) => s.locked).map((s) => s.name)}
            notes={notes.value.filter((n) =>
              query === "skills"
                ? n.kind === "skill"
                : (n.key + " " + n.text).toLowerCase().includes(query.toLowerCase()),
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
  const cards = (
    <>
      {visible &&
        counts.reminders?.contradictions?.map((c) => (
          <MemoryContradictionCard
            key={c.id}
            conflict={c}
            writable={writable}
            apply={(action) => apply(c.a, action)}
          />
        ))}
      {main && writable && (
        <WorkflowReview
          runInHeader
          key={memoryThreadKey(ref)}
          {...ref}
          revision={revision}
          openProposal={(key) => setMemoryCard(ref, key)}
        />
      )}
      {reviewCards}
    </>
  );
  return (
    <>
      {visible && (
        <section className="shrink-0 border-b">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex grow flex-wrap items-center gap-x-2 px-4 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              <span aria-hidden>{expanded ? "▾" : "▸"}</span>
              <strong>Memory</strong>
              <span>
                {countLabel(counts.total, "note")} · {counts.proposed} proposed · {counts.disputed}{" "}
                disputed
              </span>
              <span>Stored unencrypted on this machine</span>
            </button>
            {main && writable && (
              <div className="shrink-0 py-1 pr-4">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={reviewing}
                  onClick={async () => {
                    setReviewing(true);
                    try {
                      await workflowAction(ref, "run");
                    } catch {
                      toastManager.add({
                        type: "error",
                        title: "Could not run the workflow review.",
                      });
                    }
                    setReviewing(false);
                  }}
                >
                  Review my workflow
                </Button>
              </div>
            )}
          </div>
          <MemoryOwnerLine />
          {counts.reminders && (
            <div className="px-4 text-xs">
              Rule reminders: {counts.reminders.fired} fired · {counts.reminders.acknowledged}{" "}
              acknowledged · {counts.reminders.contested} contested
              {counts.reminders.latest.map((note) => (
                <aside key={note.key} className="my-2 rounded border-l-2 bg-muted p-2">
                  <strong>Rule reminder · {note.key}</strong>
                  <blockquote className="whitespace-pre-wrap">{note.text}</blockquote>
                  <span>Source: {note.source}</span>
                </aside>
              ))}
            </div>
          )}
          {loadNotes && notes.error && <p role="alert">{notes.error}</p>}
          {expanded && writable && <MemoryPreferences key={memoryThreadKey(ref)} {...ref} />}
          {expanded && notes.value && (
            <MemoryNotes expanded notes={notes.value} writable={writable} apply={apply} />
          )}
        </section>
      )}
      {renderTimeline ? renderTimeline(cards) : cards}
    </>
  );
}
