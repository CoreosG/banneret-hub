import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeEvents from "node:events";

const checkout = process.argv[2];
if (!checkout) throw new Error("Pass the path to an installed banneret-plugin-template checkout.");
const root = NodePath.resolve(import.meta.dirname, "../..");
const fixture = NodePath.resolve(checkout);
const { listen } = await import(
  NodeURL.pathToFileURL(NodePath.join(fixture, "src/server.ts")).href
);
const manifest = await NodeFSP.readFile(NodePath.join(fixture, "plugin.json"));
const mcp = await listen(0);
const files = NodeHttp.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" }).end(manifest);
});
try {
  files.listen(0, "127.0.0.1");
  await NodeEvents.once(files, "listening");
  const test = NodeChildProcess.spawn(
    NodePath.join(root, "node_modules/.bin/vp"),
    ["test", "run", "apps/server/src/banneret/plugins/registry.test.ts", "--maxWorkers", "1"],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        BANNERET_TEMPLATE_MCP: `http://127.0.0.1:${mcp.address().port}/mcp`,
        BANNERET_TEMPLATE_MANIFEST: `http://127.0.0.1:${files.address().port}/plugin.json`,
      },
    },
  );
  const [code] = await NodeEvents.once(test, "exit");
  process.exitCode = code ?? 1;
} finally {
  await Promise.all([mcp[Symbol.asyncDispose](), files[Symbol.asyncDispose]()]);
}
