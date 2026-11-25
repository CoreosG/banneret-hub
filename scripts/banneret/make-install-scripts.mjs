#!/usr/bin/env node
// Banneret Hub: derives install.sh / install.ps1 release assets from upstream's scripts at build
// time, so upstream's installer fixes flow in without merge conflicts. The installed command is
// `banneret`; the runtime executable inside ~/.banneret/runtime/versions/<v>/ keeps upstream's name.
// Usage: node scripts/banneret/make-install-scripts.mjs <output-dir>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const outputDir = NodePath.resolve(process.argv[2] ?? "release-assets");
const REPO = "CoreosG/banneret-hub";
const INSTALL_BASE = `https://github.com/${REPO}/releases/latest/download`;

/** [from, to, minimum count]: a count of 0 found means upstream changed the script; fail loudly. */
const shRules = [
  [`repo="pingdotgg/t3code"`, `repo="${REPO}"`, 1],
  [`$HOME/.t3}`, `$HOME/.banneret}`, 1],
  ["https://t3.codes/install.sh", `${INSTALL_BASE}/install.sh`, 1],
  ["${bin_dir}/t3", "${bin_dir}/banneret", 5],
  ["${bin_dir}/.t3.", "${bin_dir}/.banneret.", 1],
  ["${t3_home}/bin/t3", "${t3_home}/bin/banneret", 1],
  [`pwd)/t3"`, `pwd)/banneret"`, 1],
  ["command -v t3 ", "command -v banneret ", 1],
  ["Setting up the t3 command", "Setting up the banneret command", 1],
];
const ps1Rules = [
  [`$repo = "pingdotgg/t3code"`, `$repo = "${REPO}"`, 1],
  [`Join-Path $HOME ".t3"`, `Join-Path $HOME ".banneret"`, 1],
  ["https://t3.codes/install.ps1", `${INSTALL_BASE}/install.ps1`, 1],
  [`Join-Path $binDir "t3.cmd"`, `Join-Path $binDir "banneret.cmd"`, 1],
  ["Get-Command t3 ", "Get-Command banneret ", 1],
  ["Run ${bold}t3$reset", "Run ${bold}banneret$reset", 2],
  ["${bold}t3 up$reset", "${bold}banneret up$reset", 1],
  ["Setting up the t3 command", "Setting up the banneret command", 1],
];

function transform(file, rules) {
  let text = NodeFS.readFileSync(NodePath.join(repoRoot, "scripts", file), "utf8");
  for (const [from, to, minimum] of rules) {
    const count = text.split(from).length - 1;
    if (count < minimum) {
      throw new Error(
        `${file}: expected at least ${minimum} of ${JSON.stringify(from)}, found ${count}`,
      );
    }
    text = text.split(from).join(to);
  }
  const header =
    file === "install.sh"
      ? "# Banneret Hub installer (unofficial T3 Code fork), generated from upstream's install.sh.\n"
      : "# Banneret Hub installer (unofficial T3 Code fork), generated from upstream's install.ps1.\n";
  const lines = text.split("\n");
  const insertAt = lines[0].startsWith("#!") ? 1 : 0;
  lines.splice(insertAt, 0, header.trimEnd());
  NodeFS.mkdirSync(outputDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(outputDir, file), lines.join("\n"));
  console.log(`wrote ${NodePath.join(outputDir, file)}`);
}

transform("install.sh", shRules);
transform("install.ps1", ps1Rules);
