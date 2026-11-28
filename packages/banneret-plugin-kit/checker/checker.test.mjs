import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import { test } from "vite-plus/test";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { tools } from "../src/index.ts";
import { skillsServer } from "./skills-server.fixture.mjs";
import { check } from "./checks.mjs";

const manifest = {
  source: "acme",
  description: "Test fixture",
  auth: "service",
  toolPrefix: "acme_",
  capabilities: ["skills"],
};
test("reference skills over stdio and HTTP, including broken resource hint", async (t) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "banneret-check-"));
  t.onTestFinished(() => NodeFSP.rm(dir, { recursive: true, force: true }));
  const file = NodePath.join(dir, "manifest.json");
  await NodeFSP.writeFile(file, JSON.stringify(manifest));
  const bundle = NodePath.join(dir, "checker.mjs");
  await NodeUtil.promisify(NodeChildProcess.execFile)(
    process.execPath,
    [NodePath.join(import.meta.dirname, "build.mjs"), bundle],
    { cwd: NodePath.dirname(import.meta.dirname) },
  );
  const args = [bundle, "--json", "--manifest", file];
  const run = NodeUtil.promisify(NodeChildProcess.execFile);
  const stdio = [
    ...args,
    "--",
    process.execPath,
    NodePath.join(import.meta.dirname, "skills-server.fixture.mjs"),
  ];
  NodeAssert.equal(JSON.parse((await run(process.execPath, stdio)).stdout).passed, true);
  await NodeAssert.rejects(run(process.execPath, [...stdio, "broken"]), (error) => {
    NodeAssert.match(JSON.parse(error.stdout).checks.at(-1).hint, /same text\/markdown/);
    return error.code === 1;
  });
  const http = NodeHttp.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const server = skillsServer(false);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => http.close());
  NodeAssert.equal(
    JSON.parse(
      (
        await run(process.execPath, [
          ...args,
          "--url",
          `http://127.0.0.1:${http.address().port}/mcp`,
        ])
      ).stdout,
    ).passed,
    true,
  );
});

const card = JSON.parse(
  await NodeFSP.readFile(
    new URL("../../../docs/banneret/relay-v1/examples/task.json", import.meta.url),
    "utf8",
  ),
);
function fake(actor, state, broken) {
  return {
    listTools: async () => ({ tools: Object.keys(tools).map((name) => ({ name })) }),
    async callTool({ name, arguments: args }) {
      const ok = (structuredContent) => ({ structuredContent });
      const note = (value) => ok({ data: JSON.stringify(value) });
      const failed = { isError: true };
      if (name === "tasks_list_boards") return ok({ boards: [{ id: "board", title: "Board" }] });
      if (name === "tasks_list_tasks") return ok({ tasks: [card] });
      if (name.startsWith("tasks_") && args.taskId !== card.task.id) return failed;
      if (name === "tasks_read") return ok(card);
      // One result for each caller, tool and key. Without a key, every call is a new one.
      const once = (run) => {
        const id =
          args.idempotencyKey &&
          [broken === "shared-key" ? "" : actor, name, args.idempotencyKey].join(" ");
        if (id && broken !== "ignores-key" && state.results?.has(id))
          return ok(state.results.get(id));
        const result = { status: run() };
        if (id) (state.results ??= new Map()).set(id, result);
        return ok(result);
      };
      if (name === "tasks_claim") {
        return once(() => {
          if (!state.holder || broken === "race") state.holder = actor;
          return state.holder === actor ? "claimed" : "conflict";
        });
      }
      if (name === "tasks_release") {
        if (args.reason !== "handing_over") return failed;
        return once(() => {
          if (state.holder !== actor) return "not_holder";
          delete state.holder;
          return "released";
        });
      }
      if (name.endsWith("_propose")) {
        state.note = {
          ...args,
          trust: broken === "confirm" ? "confirmed" : "proposed",
          useCount: 0,
        };
      }
      if (!state.note) return failed;
      if (name.endsWith("_search")) return note([state.note]);
      if (name.endsWith("_use")) state.note.useCount = 1;
      if (name.endsWith("_flag"))
        state.note.trust = broken === "resolve" && args.resolve ? "confirmed" : "disputed";
      return note(state.note);
    },
  };
}
test.each([
  ["tasks", undefined],
  ["tasks", "race", "Exactly one claim"],
  ["tasks", "ignores-key", "repeated tasks_release"],
  ["tasks", "shared-key", "to its caller"],
  ["memory", undefined],
  ["memory", "confirm", "banneret_memory_propose"],
  ["memory", "resolve", "banneret_memory_flag"],
])("%s provider with %s defect", async (capability, broken, hint) => {
  const state = {};
  const report = await check(
    { ...manifest, toolPrefix: "", capabilities: [capability], atomicClaim: true },
    fake("one", state, broken),
    { peer: fake("two", state, broken), taskId: card.task.id },
  );
  NodeAssert.equal(report.passed, !broken, JSON.stringify(report));
  if (broken) NodeAssert.ok(report.checks.at(-1).hint.includes(hint));
});

test("the bundled checker prints a profile and checks a draft", async (t) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "banneret-profile-"));
  t.onTestFinished(() => NodeFSP.rm(dir, { recursive: true, force: true }));
  const bundle = NodePath.join(dir, "checker.mjs");
  const run = NodeUtil.promisify(NodeChildProcess.execFile);
  await run(process.execPath, [NodePath.join(import.meta.dirname, "build.mjs"), bundle], {
    cwd: NodePath.dirname(import.meta.dirname),
  });
  const cli = async (...args) => (await run(process.execPath, [bundle, ...args])).stdout;
  const file = NodePath.join(dir, "profile.json");

  NodeAssert.ok(JSON.parse(await cli("--print-profile", "schema")).properties.instructions);
  for (const id of ["codex", "someAcpAgent"]) {
    await NodeFSP.writeFile(file, await cli("--print-profile", id));
    NodeAssert.equal(JSON.parse(await cli("--profile", file, "--json")).passed, true);
  }

  const broken = JSON.parse(await cli("--print-profile", "codex"));
  delete broken.memory.learns.from;
  await NodeFSP.writeFile(file, JSON.stringify(broken));
  await NodeAssert.rejects(cli("--profile", file), (error) => {
    NodeAssert.equal(error.code, 1);
    NodeAssert.match(error.stdout, /FAIL shape .*memory\.learns\.from: /s);
    return true;
  });
});
