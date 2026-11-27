// @effect-diagnostics nodeBuiltinImport:off - isolated local git and SQLite fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { afterEach, expect, it } from "vite-plus/test";
import { allowsPersonalRepo, syncCopy, verifyRepo } from "./gitCopy.ts";
import { withNotes, type NoteStore } from "./store.ts";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-memory-test-"));
  dirs.push(dir);
  const url = NodePath.join(dir, "remote.git");
  NodeChildProcess.execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", url]);
  const machine = (name: string) => {
    const file = NodePath.join(dir, name);
    const open = <T>(f: (s: NoteStore) => T) => withNotes(file, "project", 123, f);
    open((s) => s.repo.configure(url, false));
    const ctx = {
      file,
      now: () => 123,
      project: "project",
      workspace: "common",
      projectFolder: "repo",
      enterprise: true,
      allowed: async () => true,
    };
    return {
      ctx,
      open,
      sync: () => syncCopy(ctx, async () => {}),
      edit: (text: string) =>
        open((s) => {
          const note = s.list(false)[0]!;
          s.review(note.key, note.version, {
            kind: note.trust === "proposed" ? "editConfirm" : "edit",
            text,
          });
        }),
    };
  };
  const a = machine("a"),
    b = machine("b");
  a.open((s) =>
    s.propose({ scope: "personal", key: "style", text: "first", kind: "user", source: "person" }),
  );
  return { a, b, url };
}
it("pushes personal notes, pulls and keeps two edits for review", async () => {
  const { a, b, url } = setup();
  a.open((s) =>
    s.propose({
      scope: "project",
      key: "work",
      text: "private project",
      kind: "project",
      source: "person",
    }),
  );
  await a.sync();
  expect(
    NodeChildProcess.execFileSync(
      "git",
      ["--git-dir", url, "ls-tree", "-r", "--name-only", "HEAD"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n"),
  ).toEqual(["common/personal/MEMORY.md", "common/personal/note-style.md"]);
  await b.sync();
  expect(b.open((s) => s.read("style").text)).toBe("first");
  a.open((s) =>
    s.review("style", s.list(false).find((n) => n.key === "style")!.version, {
      kind: "editConfirm",
      text: "left",
    }),
  );
  await a.sync();
  b.edit("right");
  await b.sync();
  expect(b.open((s) => s.list(false)[0])).toMatchObject({
    text: "right",
    trust: "proposed",
    alternative: "left",
  });
  b.edit("chosen");
  await b.sync();
  await a.sync();
  expect(a.open((s) => s.read("style").text)).toBe("chosen");
});
it("preserves a remote edit after local deletion", async () => {
  const { a, b } = setup();
  await a.sync();
  await b.sync();
  b.open((s) => s.review("style", s.list(false)[0]!.version, { kind: "remove" }));
  a.edit("edited");
  await a.sync();
  await b.sync();
  expect(b.open((s) => s.list(false)[0])).toMatchObject({ text: "edited", trust: "proposed" });
  b.open((s) => s.review("style", s.list(false)[0]!.version, { kind: "dismiss" }));
  await b.sync();
  await a.sync();
  expect(a.open((s) => s.list(false))).toEqual([]);
});
it("refuses a public repo and company opt-out before git access", async () => {
  await expect(
    verifyRepo("https://github.com/owner/memory", async () => ({
      visibility: "PUBLIC",
      owner: "owner",
      login: "owner",
    })),
  ).rejects.toThrow("private");
  const { a } = setup();
  expect(allowsPersonalRepo({})).toBe(true);
  await expect(
    syncCopy(
      { ...a.ctx, allowed: async () => allowsPersonalRepo({ memory: { personalRepo: false } }) },
      async () => {
        throw new Error("unexpected git access");
      },
    ),
  ).rejects.toThrow("disabled");
});

it("leaves a flagged secret local while copying other allowed notes", async () => {
  const { a, url } = setup();
  a.open((s) => {
    s.flag("style", "password=example-only-credential");
    s.propose({
      scope: "project",
      key: "safe",
      source: "person",
      text: "ordinary",
      kind: "reference",
    });
    s.repo.configure(url, true);
  });
  expect(await a.sync()).toContain("token, password or private key");
  const files = NodeChildProcess.execFileSync(
    "git",
    ["--git-dir", url, "ls-tree", "-r", "--name-only", "HEAD"],
    { encoding: "utf8" },
  );
  expect(files).toContain("common/project/repo/note-safe.md");
  expect(files).not.toContain("style");
  expect(a.open((s) => s.read("style").trust)).toBe("disputed");
});
