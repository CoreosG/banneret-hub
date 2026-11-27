import type { BanneretTeam, OfficeRoomPage } from "@t3tools/contracts";
import { personForLogin, type Detail } from "../sprites";

export type Person = BanneretTeam["people"][number];
export type Session = OfficeRoomPage["sessions"][number];
type Sprite = ReturnType<typeof personForLogin>;
export type Desk = {
  presence?: string | undefined;
  person: Person;
  seated: boolean;
  sessions: readonly Session[];
  info: string;
};
export type Item = {
  presence?: string | undefined;
  id: string;
  x: number;
  y: number;
  label: string;
  info: string;
};
export type Tile = { x: number; y: number; depth: number; sprite: Sprite };
export function dimensions(desks: number) {
  const columns = Math.min(4, Math.max(desks ? 2 : 1, desks));
  const rows = Math.max(desks ? 2 : 1, Math.ceil(Math.min(12, desks) / 4));
  return { columns, rows, width: (columns + rows) * 72 + 24, height: (columns + rows) * 36 + 86 };
}
export function detailFor(zoom: number, desks: readonly Desk[], visible: number): Detail {
  const robots = desks.reduce((n, d) => n + d.sessions.length, 0);
  const targets = desks.length + robots + 2;
  if (zoom < 0.5 || targets * visible > 236 || desks.some((d) => d.sessions.length > 6))
    return "mark";
  if ((desks.length * 3 + robots + 3) * visible > 600 || zoom < 1) return "simple";
  return "full";
}
export function layout(desks: readonly Desk[], detail: Detail, viewer?: string) {
  const tiles: Tile[] = [],
    items: Item[] = [];
  const { rows } = dimensions(desks.length);
  function place(gx: number, gy: number, sprite: Sprite, item?: Omit<Item, "x" | "y">) {
    const x = Math.round(12 + rows * 72 + (gx - gy) * 72);
    const y = Math.round(48 + (gx + gy) * 36);
    tiles.push({ x, y, depth: gx + gy, sprite });
    if (item) items.push({ ...item, x, y });
  }
  if (detail !== "mark")
    desks.slice(0, 12).forEach(({ person: p, seated, sessions, info, presence }, i) => {
      const gx = (i % 4) + 0.3,
        gy = Math.floor(i / 4) + 0.3;
      if (seated) place(gx - 0.1, gy - 0.05, personForLogin(p.login));
      place(
        gx + 0.12,
        gy + 0.12,
        { kind: "object", name: "desk" },
        { id: "desk/" + p.id, label: p.displayName ?? p.login, info, presence },
      );
      sessions.forEach((s, j) => {
        const name =
          s.stopReason === "usage_limit"
            ? "usage-limit"
            : s.state === "waiting"
              ? p.login === viewer
                ? "waiting-on-you"
                : "waiting-on-someone-else"
              : s.state === "working" || s.state === "stopped" || s.state === "idle"
                ? s.state
                : "not-heard-from";
        place(
          gx + 0.55 - (j % 3) * 0.25,
          gy + Math.floor(j / 3) * 0.32,
          { kind: "agent", name },
          {
            id: "agent/" + s.id,
            label: s.provider + " · " + s.state,
            info: [p.login, s.id, s.taskId].filter(Boolean).join(" · "),
          },
        );
      });
    });
  return { tiles: tiles.sort((a, b) => a.depth - b.depth), items };
}
