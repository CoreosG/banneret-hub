import { build } from "esbuild";

await build({
  entryPoints: ["checker/cli.mjs"],
  outfile: process.argv[2] ?? "dist/banneret-plugin-check.mjs",
  platform: "node",
  format: "esm",
  bundle: true,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
