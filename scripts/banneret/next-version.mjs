#!/usr/bin/env node
// Prints the next Banneret version: upstream X.Y.Z becomes X.Y.(Z*100 + n), n = our releases on
// that base (0.1.12 -> 0.1.1200, 0.1.1201...). Always increasing, so updaters see each release as
// newer. See docs/banneret/maintaining.md#versions.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const upstreamTag = NodeFS.readFileSync(
  NodePath.join(repoRoot, "scripts/banneret/UPSTREAM_TAG"),
  "utf8",
).trim();
const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(upstreamTag);
if (!match)
  throw new Error(
    `scripts/banneret/UPSTREAM_TAG must be a stable tag like v0.1.12, got ${upstreamTag}`,
  );
const [, major, minor, patch] = match.map(Number);
const base = Number(patch) * 100;

const ours = NodeChildProcess.execFileSync("git", ["tag", "--list", `v${major}.${minor}.*`], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .map((tag) => /^v\d+\.\d+\.(\d+)$/.exec(tag.trim()))
  .filter(Boolean)
  .map((m) => Number(m[1]))
  .filter((n) => n >= base && n < base + 100);

const next = ours.length === 0 ? base : Math.max(...ours) + 1;
if (next >= base + 100)
  throw new Error(`100 Banneret releases on ${upstreamTag}; sync upstream first.`);
console.log(`${major}.${minor}.${next}`);
