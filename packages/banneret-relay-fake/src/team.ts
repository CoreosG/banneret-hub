import type { TeamPresenceEdit, TeamPresenceValues } from "@t3tools/contracts";

export function editPresence(
  current: TeamPresenceValues,
  edit: TeamPresenceEdit,
): TeamPresenceValues {
  const status = edit.status === undefined ? current.status : edit.status;
  const seatBoard = edit.seatBoard === undefined ? current.seatBoard : edit.seatBoard;
  return {
    presence: edit.presence ?? current.presence,
    ...(status && { status }),
    ...(seatBoard && { seatBoard }),
  };
}

const priority = ["stopped", "idle", "working", "notHeardFrom", "waiting"] as const;
type CountState = (typeof priority)[number];
export interface RoomAgent {
  id: string;
  parentId?: string;
  personId: string;
  state: string;
}
export const emptyCounts = () => ({ working: 0, waiting: 0, notHeardFrom: 0, idle: 0, stopped: 0 });

export function leadSessions<T extends RoomAgent>(sessions: readonly T[]) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const session of sessions) {
    const parent = session.parentId && byId.get(session.parentId);
    if (!parent || parent === session || parent.personId !== session.personId) roots.push(session);
    else {
      const siblings = children.get(parent.id) ?? [];
      siblings.push(session);
      children.set(parent.id, siblings);
    }
  }
  const visited = new Set<string>();
  const leads: { session: T; state: CountState }[] = [];
  for (const session of [...roots, ...sessions]) {
    if (visited.has(session.id)) continue;
    let rank = 0;
    const stack = [session];
    while (stack.length) {
      const next = stack.pop()!;
      if (visited.has(next.id)) continue;
      visited.add(next.id);
      const state = next.state === "not_heard_from" ? "notHeardFrom" : next.state;
      rank = Math.max(
        rank,
        priority.findIndex((s) => s === state),
      );
      stack.push(...(children.get(next.id) ?? []));
    }
    leads.push({ session, state: priority[rank]! });
  }
  return leads;
}
