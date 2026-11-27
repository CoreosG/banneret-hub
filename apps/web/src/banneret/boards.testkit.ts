// Banneret Hub test helpers: one board file wrapped as the relay's whole `boards` index.
import type { BanneretBoard, BanneretBoardEntry, BanneretBoards } from "@t3tools/contracts";

export const boardEntry = (
  id: string,
  title: string,
  board: BanneretBoard | null,
): BanneretBoardEntry => {
  const counts: Record<string, number> = {};
  for (const card of board?.cards ?? []) counts[card.column] = (counts[card.column] ?? 0) + 1;
  return { id, title, mode: "dev", source: { kind: "filter" }, counts, board };
};

/** A relay with this one board, "Platform". */
export const singleBoard = (board: BanneretBoard): BanneretBoards => ({
  boards: [boardEntry("platform", "Platform", board)],
});
