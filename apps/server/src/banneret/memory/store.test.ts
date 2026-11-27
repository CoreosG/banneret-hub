// @effect-diagnostics nodeBuiltinImport:off - opens and cleans up an isolated SQLite file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, expect, it } from "vite-plus/test";
import { withNotes, type Proposal } from "./store.ts";

const day = 86400000;
const proposal: Proposal = {
  key: "style",
  text: "Prefer small patches.",
  source: "requested in chat",
  scope: "project",
  kind: "feedback",
};
const dirs: string[] = [];
function fixture() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "memory-"));
  dirs.push(dir);
  return NodePath.join(dir, "notes.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

it("indexes proposals, counts distinct chats and isolates project reads and writes", () => {
  const file = fixture();
  withNotes(file, "a", 0, (s) => {
    expect(s.propose(proposal).trust).toBe("proposed");
    expect(s.search("small patches")).toHaveLength(1);
    expect(s.use("style", "one").useCount).toBe(1);
    expect(s.use("style", "one").useCount).toBe(1);
    s.use("style", "two");
    expect(s.use("style", "three").trust).toBe("proposed");
  });
  withNotes(file, "b", 1, (s) => {
    expect(s.search("patches")).toEqual([]);
    expect(() => s.flag("style", "wrong")).toThrow();
  });
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec("update notes set confirmedAt=0");
  db.close();
  for (const [days, level] of [
    [29, "confirmed"],
    [30, "trusted"],
    [45, "stale"],
    [90, "archived"],
  ] as const)
    expect(withNotes(file, "a", days * day, (s) => s.read("style").trust)).toBe(level);
  withNotes(file, "a", 90 * day, (s) => {
    expect(s.flag("style", "obsolete").trust).toBe("disputed");
    expect(s.counts()).toEqual({ total: 1, disputed: 1, proposed: 0 });
    expect(s.index()).not.toContain("patches");
  });
});
it("keeps complete pinned entries inside the UTF-8 start index budget", () => {
  const file = fixture();
  withNotes(file, "a", 0, (s) => {
    for (let i = 0; i < 100; i++)
      s.propose({ ...proposal, key: "note-" + i, text: "😀".repeat(200) });
  });
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec("update notes set pinned=1,confirmedAt=0");
  db.close();
  withNotes(file, "a", 100 * day, (s) => {
    expect(s.read("note-0").trust).toBe("pinned");
    const index = s.index();
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(6144);
    expect(index).toContain("note-0");
    for (const line of index.split("\n").slice(1)) expect(JSON.parse(line)).toHaveProperty("key");
  });
});
