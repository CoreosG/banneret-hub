// @effect-diagnostics nodeBuiltinImport:off - bounded, read-only access to provider rule files.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { scanMemory } from "./files.ts";

export async function providerRules(root: string, activity: string, home = NodeOS.homedir()) {
  const memory = NodePath.join(
    home,
    ".claude",
    "projects",
    NodePath.resolve(root).replace(/[^a-zA-Z0-9]/g, "-"),
    "memory",
  );
  const topics =
    (await NodeFSP.realpath(memory).catch(() => "")) === memory
      ? (await NodeFSP.readdir(memory).catch(() => []))
          .filter((n) => n.endsWith(".md") && n !== "MEMORY.md")
          .sort()
          .slice(0, 12)
      : [];
  const paths = [
    NodePath.join(root, "AGENTS.md"),
    NodePath.join(root, "CLAUDE.md"),
    NodePath.join(root, ".claude", "CLAUDE.md"),
    NodePath.join(home, ".claude", "CLAUDE.md"),
    NodePath.join(home, ".codex", "AGENTS.md"),
    NodePath.join(home, ".codex", "memories", "MEMORY.md"),
    NodePath.join(memory, "MEMORY.md"),
    ...topics.map((n) => NodePath.join(memory, n)),
  ];
  const words = new Set(activity.toLowerCase().match(/[a-z0-9_-]{3,}/g));
  const matches = await Promise.all(
    paths.map(async (path) => {
      if ((await NodeFSP.realpath(path).catch(() => "")) !== path) return [];
      const file = await NodeFSP.open(
        path,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      ).catch(() => null);
      if (!file) return [];
      try {
        if (!(await file.stat()).isFile()) return [];
        const buffer = Buffer.alloc(65536);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return buffer
          .toString("utf8", 0, bytesRead)
          .split("\n")
          .flatMap((line, i) => {
            const text = line.trim();
            if (!text || text.length > 512) return [];
            try {
              scanMemory(text);
            } catch {
              return [];
            }
            const score = [...new Set(text.toLowerCase().match(/[a-z0-9_-]{3,}/g))].filter((w) =>
              words.has(w),
            ).length;
            return score ? [{ source: path + ":" + (i + 1), text, score }] : [];
          });
      } finally {
        await file.close();
      }
    }),
  );
  return matches
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ text, source }) => ({ text, source }));
}
