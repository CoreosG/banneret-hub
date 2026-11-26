#!/usr/bin/env node
// Banneret Hub: fails on official T3 Code identity in shipped source beyond identity-baseline.json.
// Bundled source is checked after brand.mjs's rewrite, so a rule that stops matching fails here.
//   node scripts/banneret/check-identity.mjs            # check
//   node scripts/banneret/check-identity.mjs --update   # accept the current hits as the baseline
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { rebrandText } from "./brand.mjs";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const baselinePath = NodePath.join(repoRoot, "scripts/banneret/identity-baseline.json");

const patterns = [
  { id: "home-dir", regex: /["'`/]\.t3["'`/]|"\.t3"\)|\$HOME\/\.t3\b|~\/\.t3\b/ },
  { id: "app-id", regex: /com\.t3tools\./ },
  { id: "release-repo", regex: /pingdotgg\/t3code/ },
  { id: "profile-dir", regex: /"t3code(-v2|-dev)?"/ },
  { id: "launcher-name", regex: /"t3\.cmd"|"t3\.exe"|command -v t3\b/ },
  // The app-link scheme: `t3code://`, "t3code-dev:" protocol checks, /^t3code(?:-[a-z]+)?:$/.
  { id: "deep-link", regex: /\bt3code(-dev)?:(\/\/|["'$])|\^t3code\(/ },
  {
    id: "official-host",
    regex: /https:\/\/(ingest|app|nightly\.app)\.t3\.codes|t3\.codes\/install/,
  },
];

/** Applied to server-bundle source after the build's rewrite: the user must never see `t3 ...`. */
const cliNamePattern = { id: "cli-name", regex: /(?<![\w./@$-])t3(?= [a-z<.-]|\\?`)/ };
const serverBundle = /^(apps\/server\/src|packages\/[^/]+\/src)\//;
const bundled = /^(apps\/(server|desktop|web)\/src|packages\/[^/]+\/src)\/.*\.[cm]?[jt]sx?$/;
const comment = /^\s*(\/\/|\*|\/\*)/;

const scanned = [
  "apps/server/src",
  "apps/desktop/src",
  "apps/desktop/scripts",
  "apps/web/src",
  "packages",
  "scripts",
];
const excluded = [
  /\.test\.[cm]?[jt]sx?$/,
  /\/test\//,
  /__tests__/,
  /\/node_modules\//,
  /\/i18n\/translations\//,
  /^scripts\/banneret\//,
  /\.md$/,
];

const files = NodeChildProcess.execFileSync("git", ["ls-files", "--", ...scanned], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => /\.(c|m)?(j|t)sx?$|\.sh$|\.ps1$|\.nsh$|\.json$/.test(file))
  .filter((file) => !excluded.some((regex) => regex.test(file)));

const hits = {};
for (const file of files) {
  const text = NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");
  const record = (id, line) => {
    const key = `${file} :: ${id} :: ${line.trim().slice(0, 160)}`;
    hits[key] = (hits[key] ?? 0) + 1;
  };
  const shipped = bundled.test(file) ? rebrandText(text) : text;
  for (const line of shipped.split("\n")) {
    for (const { id, regex } of patterns) if (regex.test(line)) record(id, line);
  }
  if (serverBundle.test(file) && /\.[cm]?[jt]sx?$/.test(file)) {
    for (const line of rebrandText(text, { cli: true }).split("\n")) {
      if (!comment.test(line) && cliNamePattern.regex.test(line)) record(cliNamePattern.id, line);
    }
  }
}

if (process.argv.includes("--update")) {
  const sorted = Object.fromEntries(Object.entries(hits).sort(([a], [b]) => a.localeCompare(b)));
  NodeFS.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`baseline: ${Object.keys(sorted).length} reviewed hits`);
  process.exit(0);
}

const baseline = NodeFS.existsSync(baselinePath)
  ? JSON.parse(NodeFS.readFileSync(baselinePath, "utf8"))
  : {};
const fresh = Object.entries(hits).filter(([key, count]) => (baseline[key] ?? 0) < count);
if (fresh.length > 0) {
  console.error(
    "New official T3 Code identity in shipped source (rename it, or review and --update):",
  );
  for (const [key] of fresh) console.error(`  ${key}`);
  process.exit(1);
}
console.log(`identity check passed (${Object.keys(hits).length} reviewed hits)`);
