import type { OfficeSummary } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";
import type { RelayTarget } from "../enrolmentStore";
import { feedRpc } from "../relayFeedStore";

export function createAgentIndex(target: RelayTarget, summary: OfficeSummary) {
  let snapshot = {
    byPerson: new Map(summary.agents.map((row) => [row.personId, row])),
    cursor: summary.agentsNextCursor,
    last: summary.agents.at(-1)?.personId,
    error: false,
  };
  const listeners = new Set<() => void>();
  let loading = false;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    read: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {
      snapshot = { ...snapshot, error: false };
      notify();
    },
    async load() {
      const { cursor } = snapshot;
      if (!cursor || loading || snapshot.error) return;
      loading = true;
      const next = await feedRpc.agents(target, cursor);
      loading = false;
      if (next && next.nextCursor !== cursor) {
        const byPerson = new Map(snapshot.byPerson);
        for (const row of next.agents) byPerson.set(row.personId, row);
        snapshot = {
          byPerson,
          cursor: next.nextCursor,
          last: next.agents.at(-1)?.personId ?? snapshot.last,
          error: false,
        };
      } else snapshot = { ...snapshot, error: true };
      notify();
    },
  };
}

export type AgentIndex = ReturnType<typeof createAgentIndex>;
export function useAgentIndex(index: AgentIndex) {
  return useSyncExternalStore(index.subscribe, index.read);
}

export function needsAgent(index: ReturnType<AgentIndex["read"]>, id: string) {
  return (
    !!index.cursor && !index.byPerson.has(id) && (!index.last || id.localeCompare(index.last) > 0)
  );
}

export function useAgentPage(index: AgentIndex, needed: boolean) {
  const { cursor, error } = useAgentIndex(index);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetch the next relay page until the requested rows are covered
  useEffect(() => {
    if (needed && cursor && !error) void index.load();
  }, [index, needed, cursor, error]);
}
