import type { OfficeRoomPage } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import type { RelayTarget } from "../enrolmentStore";
import { feedRpc } from "../relayFeedStore";

export function useRoomSessions(
  { environmentId, relayOrigin }: RelayTarget,
  board: string | null,
  revision: string | undefined,
  enabled: boolean,
) {
  const [read, setRead] = useState<{
    revision: string | undefined;
    sessions: OfficeRoomPage["sessions"] | null;
  }>();
  const current = read?.revision === revision ? read : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follow the visible room file and its continuation pages
  useEffect(() => {
    if (!enabled || current) return;
    let cancelled = false;
    async function load() {
      const rows: OfficeRoomPage["sessions"][number][] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await feedRpc.room({ environmentId, relayOrigin }, board, cursor);
        if (cancelled) return;
        if (!page || (page.nextCursor && cursors.has(page.nextCursor))) {
          setRead({ revision, sessions: null });
          return;
        }
        rows.push(...page.sessions);
        cursor = page.nextCursor ?? undefined;
        if (cursor) cursors.add(cursor);
      } while (cursor);
      setRead({ revision, sessions: rows });
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, current, revision, board, environmentId, relayOrigin]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expire stopped sessions even if the next snapshot is delayed
  useEffect(() => {
    if (!enabled || !current?.sessions) return;
    const expiresAt = (s: OfficeRoomPage["sessions"][number]) =>
      s.state === "stopped" ? Date.parse(s.since) + 3600000 : Infinity;
    const next = Math.min(...current.sessions.map(expiresAt));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setRead((previous) =>
          previous === current && previous.sessions
            ? { ...previous, sessions: previous.sessions.filter((s) => expiresAt(s) > now) }
            : previous,
        );
      },
      Math.max(0, next - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [current, enabled]);
  return { sessions: current?.sessions, retry: () => setRead(undefined) };
}
