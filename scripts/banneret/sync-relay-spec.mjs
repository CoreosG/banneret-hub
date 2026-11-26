#!/usr/bin/env node
// One-off import only: docs/banneret/relay-v1/ here is canonical and banneret-platform mirrors it. This copies
// openapi.yaml, README.md and examples/ from a platform folder over the canonical copy (examples replaced).
//   node scripts/banneret/sync-relay-spec.mjs <platform>/internal/hub/contract/relay-v1 <commit>
// See docs/banneret/relay-v1/FAKE.md, "Changing the spec".
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const header =
  "Canonical copy. banneret-platform mirrors it at `internal/hub/contract/relay-v1/` with a drift test.";
const sourcePrefix = "First imported from banneret-platform ";

const source = process.argv[2];
const commit = process.argv[3];
if (!source || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error(
    "usage: node scripts/banneret/sync-relay-spec.mjs <path-to-platform relay-v1 folder> <full commit sha>",
  );
  process.exit(2);
}
for (const required of ["openapi.yaml", "README.md", "examples"]) {
  if (!NodeFS.existsSync(NodePath.join(source, required))) {
    console.error(
      `${source} has no ${required}; pass the platform's internal/hub/contract/relay-v1 folder.`,
    );
    process.exit(1);
  }
}

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const target = NodePath.join(repoRoot, "docs/banneret/relay-v1");
NodeFS.mkdirSync(target, { recursive: true });

NodeFS.copyFileSync(NodePath.join(source, "openapi.yaml"), NodePath.join(target, "openapi.yaml"));

// The header goes right under the title, once.
const readme = NodeFS.readFileSync(NodePath.join(source, "README.md"), "utf8")
  .split("\n")
  .filter((line) => line !== header && !line.startsWith(sourcePrefix));
const titleIndex = readme.findIndex((line) => line.startsWith("# "));
readme.splice(titleIndex + 1, 0, "", header, `${sourcePrefix}\`${commit}\`.`);
NodeFS.writeFileSync(
  NodePath.join(target, "README.md"),
  readme.join("\n").replace(/\n\n\n+/g, "\n\n"),
);

const copyJsonDir = (from, to) => {
  NodeFS.rmSync(to, { recursive: true, force: true });
  NodeFS.mkdirSync(to, { recursive: true });
  for (const entry of NodeFS.readdirSync(from, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      NodeFS.copyFileSync(NodePath.join(from, entry.name), NodePath.join(to, entry.name));
    }
  }
};
copyJsonDir(NodePath.join(source, "examples"), NodePath.join(target, "examples"));
copyJsonDir(NodePath.join(source, "examples/invalid"), NodePath.join(target, "examples/invalid"));

console.log(`Synced the relay v1 contract into ${NodePath.relative(repoRoot, target)}/`);
