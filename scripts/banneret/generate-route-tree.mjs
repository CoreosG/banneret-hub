#!/usr/bin/env node
// Banneret Hub: regenerates apps/web/src/routeTree.gen.ts without a Vite build, using the same
// generator the `tanstackRouter` plugin in apps/web/vite.config.ts runs. The sync job uses it to
// resolve conflicts in the generated file and to keep it matching the routes after a merge.
//   node scripts/banneret/generate-route-tree.mjs
// Needs the web app's dependencies installed (`vp install --filter=@t3tools/web`).
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const webRoot = NodePath.join(repoRoot, "apps/web");

// Must match the tanstackRouter(...) call in apps/web/vite.config.ts; fail rather than generate a
// different tree when upstream changes it.
const pluginCall = "tanstackRouter({ autoCodeSplitting: true })";
const pluginOptions = { autoCodeSplitting: true };
const viteConfig = NodeFS.readFileSync(NodePath.join(webRoot, "vite.config.ts"), "utf8");
if (!viteConfig.includes(pluginCall)) {
  console.error(
    `apps/web/vite.config.ts no longer calls ${pluginCall}; update pluginOptions in ${NodePath.relative(repoRoot, NodeURL.fileURLToPath(import.meta.url))}.`,
  );
  process.exit(1);
}

// The generator is a dependency of the plugin, not of the web app, so resolve it from the plugin.
const requireFromWeb = NodeModule.createRequire(NodePath.join(webRoot, "package.json"));
const pluginEntry = requireFromWeb.resolve("@tanstack/router-plugin");
const { getConfig } = requireFromWeb("@tanstack/router-plugin");
const { Generator } = NodeModule.createRequire(pluginEntry)("@tanstack/router-generator");

// The plugin resolves its config against Vite's root, which is apps/web.
const config = getConfig(pluginOptions, webRoot);
const generator = new Generator({ config, root: webRoot });
await generator.run();
console.log(
  `route tree: ${NodePath.relative(repoRoot, NodePath.resolve(webRoot, config.generatedRouteTree))}`,
);
