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

it("reviews only the displayed version and updates search across edit, dispute and removal", () => {
  withNotes(fixture(), "a", 10, (s) => {
    s.propose({ ...proposal, why: "Keep changes small" });
    const version = () => s.list(false)[0]!.version;
    const proposed = version();
    expect(s.list(true)[0]?.why).toBe("Keep changes small");
    s.review("style", proposed, { kind: "editConfirm", text: "Use atomic commits" });
    expect(s.search("patches")).toEqual([]);
    expect(s.search("atomic")[0]?.trust).toBe("confirmed");
    expect(s.list(true)).toEqual([]);
    s.flag("style", "Out of date", "chat-a");
    expect(s.list(true)[0]).toMatchObject({ flaggedBy: "chat-a", reason: "Out of date" });
    expect(() => s.review("style", proposed, { kind: "keep" })).toThrow();
    s.review("style", version(), { kind: "keep" });
    expect(s.read("style").trust).toBe("confirmed");
    s.review("style", version(), { kind: "remove" });
    expect(s.search("atomic")).toEqual([]);
    s.propose(proposal);
    s.review("style", version(), { kind: "dismiss" });
    expect(s.list(false)).toEqual([]);
  });
});

it("round trips note files and imports Claude notes and rules as proposals", () => {
  withNotes(fixture(), "project", 123, (s) => {
    s.propose({ ...proposal, text: "First line\n\n## Details\nSecond line\n" });
    const version = s.list(true)[0]!.version;
    s.review(proposal.key, version, { kind: "confirm" });
    const file = s.exportFiles()[0]!;
    expect(file.content).toContain("confirmedAt: 123");
    expect(s.importFile(file.name, file.content, "first")).toMatchObject({ skipped: 1 });
    withNotes(fixture(), "other", 456, (target) => {
      expect(target.importFile(file.name, file.content, "first")).toMatchObject({ proposed: 1 });
      expect(target.read(proposal.key)).toMatchObject({
        text: "First line\n\n## Details\nSecond line\n",
        trust: "proposed",
        confirmedAt: null,
        createdAt: 456,
      });
      expect(
        target.importFile(
          "style.md",
          "---\nname: Review style\ndescription: team style\ntype: feedback\n---\nSmall patches.",
          "second",
        ),
      ).toMatchObject({ proposed: 1 });
      expect(target.importFile("AGENTS.md", "Read the glossary.", "second")).toMatchObject({
        proposed: 1,
      });
      expect(target.importFile("CLAUDE.md", "Detailed rules.\n".repeat(400), "long")).toMatchObject(
        { proposed: 2 },
      );
      const second = target.list(true).filter((n) => n.batch === "second");
      expect(second).toHaveLength(2);
      target.confirmImport("second", second);
      expect(target.list(true).map((n) => n.batch)).not.toContain("second");
      expect(target.read(proposal.key).trust).toBe("proposed");
    });
  });
});

it("refuses secrets on import and propose without storing or echoing them", () => {
  const token = "ghp_" + "a".repeat(36);
  withNotes(fixture(), "project", 1, (s) => {
    expect(() => s.propose({ ...proposal, why: token })).toThrow("token, password or private key");
    expect(s.importFile("rules.md", token, "batch").reason).toMatch(/^Refused:/);
    expect(s.counts().total).toBe(0);
  });
});

it("keeps the confirmed skill active across restart until its owner accepts the revision", () => {
  const file = fixture();
  const text = "---\nname: publish\ndescription: Publish a release.\n---\n";
  withNotes(file, "app", 1, (s) => {
    s.proposeSkill(text + "Check the tag.", "personal", "First procedure.");
    const [first] = s.list(true);
    s.review(first!.key, first!.version, { kind: "confirm" });
    s.proposeSkill(text + "Verify the tag and checksum.", "personal", "Include the checksum.");
  });
  withNotes(file, "app", 2, (s) => {
    const [pending] = s.list(true);
    expect(s.list(false).find((n) => n.trust === "confirmed")?.text).toBe(text + "Check the tag.");
    s.review(pending!.key, pending!.version, { kind: "confirm" });
    expect(s.list(false)).toMatchObject([
      { text: text + "Verify the tag and checksum.", trust: "confirmed" },
    ]);
  });
});

it("runs a local review on demand and coalesces missed weekly reviews after restart", () => {
  const file = fixture();
  const provider = NodePath.join(NodePath.dirname(file), "CLAUDE.md");
  NodeFS.writeFileSync(provider, "Private provider rule");
  const read = (time: number, scheduled: boolean) =>
    withNotes(file, "app", time, (s) => s.workflow("main").run(s, 2, scheduled));
  expect(read(0, true)).toBeNull();
  expect(read(0, false)?.retries).toBe(2);
  withNotes(file, "app", 0, (s) => s.workflow("main").schedule(true));
  expect(read(day, true)).toBeNull();
  expect(read(day * 14, true)?.pending).toBe(true);
  expect(read(day * 14, true)).toBeNull();
  withNotes(file, "app", day * 14, (s) => {
    expect(s.counts().total).toBe(0);
    expect(s.workflow("main").current()?.pending).toBe(true);
    s.workflow("main").schedule(false);
  });
  expect(read(day * 30, true)).toBeNull();
  expect(NodeFS.readFileSync(provider, "utf8")).toBe("Private provider rule");
});
