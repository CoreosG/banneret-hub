// @effect-diagnostics nodeBuiltinImport:off - test exercises the on-disk Markdown source.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { searchKnowledge } from "./KbIndex.ts";

it("quotes heading matches and drops removed Markdown on the next lookup", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "knowledge-"));
  try {
    const file = NodePath.join(root, "guide.md");
    await NodeFSP.writeFile(file, "# Release\nThe release colour is amber.");
    await NodeFSP.symlink(NodePath.dirname(root), NodePath.join(root, "outside"));
    expect(await searchKnowledge([root], "amber")).toMatchObject([
      {
        path: "guide.md",
        heading: "Release",
        quote: expect.stringContaining("amber"),
        commitDate: null,
      },
    ]);
    const git = (...args: string[]) =>
      NodeUtil.promisify(NodeChildProcess.execFile)("git", ["-C", root, ...args]);
    await git("init", "-q");
    await git("add", "guide.md");
    await git(
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "first",
    );
    const { stdout } = await git("log", "-1", "--format=%cI");
    expect((await searchKnowledge([root], "amber"))[0]?.commitDate).toBe(stdout.trim());
    await NodeFSP.writeFile(file, "# Changed heading\nThe release colour is green.");
    await git(
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qam",
      "second",
    );
    expect((await searchKnowledge([root], "green"))[0]?.heading).toBe("Changed heading");
    expect(await searchKnowledge([root], "amber")).toEqual([]);
    await NodeFSP.unlink(file);
    expect(await searchKnowledge([root], "amber")).toEqual([]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
