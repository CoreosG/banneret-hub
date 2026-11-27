// Banneret Hub: the board last chosen in each workspace, kept in this browser only. The URL's
// `board` wins over it; it only fills in when a link names no board. Storage may be blocked, so every
// read and write is guarded and the page works without it.
const STORAGE_KEY = "banneret.board-choice.v1";

function readAll(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function rememberedBoard(workspaceId: string): string | null {
  return readAll()[workspaceId] ?? null;
}

export function rememberBoard(workspaceId: string, boardId: string): void {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readAll(), [workspaceId]: boardId }),
    );
  } catch {
    // Blocked storage: the URL still carries the choice.
  }
}
