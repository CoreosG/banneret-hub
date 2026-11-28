// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalJsonInEffect:off - a local company MCP server.
// A company source through the Hub's plugin proxy.
import * as NodeHttp from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { McpServer } from "effect/ai";

import { ServerConfig } from "../../config.ts";
import { idleThreadProjection } from "../../mcp/McpToolAccess.testkit.ts";
import { approvalMachine } from "../plugins/approvals.ts";
import { levelHandlers } from "../plugins/levelHandlers.ts";
import { pluginSource, setLevel } from "../plugins/levels.ts";
import { pluginsForThread } from "../plugins/session.ts";
import { relayHash } from "../relay/Enrolment.ts";
import {
  environmentId,
  external,
  inThread,
  makeHub,
  ORIGIN,
  read,
  shellOf,
  startTurn,
  TOOLS,
} from "./company.testkit.ts";
import { sourcesFor } from "./ThreadSources.ts";

interface Call {
  method: string;
  tool?: string;
  authorization: string | undefined;
}

/** A company MCP server: two pages of tools, and a switch for the status it answers. */
const companyServer = Effect.gen(function* () {
  const state = { tools: [] as Array<object>, status: 200, calls: [] as Call[] };
  const server = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        state.calls.push({
          method: rpc.method,
          tool: rpc.params?.name,
          authorization: request.headers.authorization,
        });
        if (state.status !== 200) {
          response.writeHead(state.status, { "www-authenticate": "Bearer" }).end();
          return;
        }
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const half = Math.ceil(state.tools.length / 2);
        const result =
          rpc.method === "tools/list"
            ? rpc.params?.cursor
              ? { tools: state.tools.slice(half) }
              : { tools: state.tools.slice(0, half), nextCursor: "2" }
            : rpc.method === "tools/call"
              ? { content: [{ type: "text", text: "company:" + rpc.params.name }] }
              : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "acme" } };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
    (server) => Effect.sync(() => server.close()),
  );
  const address = server.address() as { port: number };
  return { state, url: `http://127.0.0.1:${address.port}/mcp` };
});

const hub = makeHub(McpServer.McpServer);

describe("company sources in a thread", () => {
  it.live("adds co-<source> for both CLIs and applies owners, levels and approvals", () => {
    const threadId = ThreadId.make("thread-offer");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const company = yield* companyServer;
        company.state.tools = TOOLS;
        const t = yield* hub({ threadId, url: company.url });

        const servers = yield* t.issue;
        expect(servers?.pluginClaude).toEqual({
          "co-acme-gw": {
            type: "http",
            url: "http://localhost/banneret/plugins/co-acme-gw",
            headers: { Authorization: "Bearer session" },
          },
        });
        expect(Object.keys(servers?.pluginCodex ?? {})).toEqual(["mcp_servers.co-acme-gw"]);
        // The CLIs talk to the Hub only; the Hub talks to the company.
        expect(JSON.stringify(servers)).not.toContain(company.url);

        expect((yield* t.rpc("initialize")).json.result).toBeDefined();
        expect((yield* t.post("notifications/initialized", {}, null)).status).toBe(202);

        // Memory stays Banneret's here, and person tools reach no thread. Both pages come as one.
        const listing = yield* t.rpc("tools/list");
        expect(listing.json.result?.nextCursor).toBeUndefined();
        expect(listing.json.result?.tools?.map((tool) => tool.name)).toEqual([
          "acme_tasks_list_boards",
          "acme_tasks_list_tasks",
          "acme_tasks_read",
          "acme_tasks_claim",
          "acme_tasks_release",
          "acme_skills_list",
          "acme_skills_get",
          "acme_deploy_status",
          "acme_delete_database",
        ]);
        for (const [name, reason] of [
          ["acme_memory_search", "is not offered here"],
          ["memory_person_list", "for a person only"],
          ["acme_memory_person_confirm", "for a person only"],
        ] as const)
          expect((yield* t.call(name)).text).toContain(reason);
        expect((yield* t.call("acme_skills_get")).text).toContain("company:acme_skills_get");

        // E1: the person sets a level for the source like for any other.
        expect(yield* levelHandlers["plugins.levels"]({ threadId })).toEqual([
          { source: "banneret", level: "read_write" },
          { source: "plugin:co-acme-gw", level: "read_write" },
        ]);
        yield* setLevel(threadId, pluginSource("co-acme-gw"), "read");
        expect(yield* t.names).toEqual([
          "acme_tasks_list_boards",
          "acme_tasks_list_tasks",
          "acme_tasks_read",
          "acme_skills_list",
          "acme_skills_get",
          "acme_deploy_status",
        ]);
        expect((yield* t.call("acme_tasks_claim")).text).toContain("is set to read");
        yield* setLevel(threadId, pluginSource("co-acme-gw"), "none");
        expect((yield* t.call("acme_tasks_read")).text).toContain("is set to none");
        yield* setLevel(threadId, pluginSource("co-acme-gw"), "read_write");

        // E3: a write waits for the person, and only the approved call reaches the company.
        const approvals = yield* approvalMachine(environmentId);
        const nextCard = approvals.updates.pipe(
          Stream.mapEffect(() => approvals.list()),
          Stream.filter((rows) => rows.length > 0),
          Stream.runHead,
          Effect.flatMap(Effect.fromOption),
          Effect.map((rows) => rows[0]!),
        );
        const writes = () =>
          company.state.calls.filter(
            (c) => c.method === "tools/call" && c.tool === "acme_tasks_claim",
          );
        const held = yield* t.call("acme_tasks_claim", { key: "A-1" }).pipe(Effect.forkChild);
        const first = yield* nextCard;
        expect(first.source).toBe("plugin:co-acme-gw");
        expect(writes()).toEqual([]);
        yield* approvals.decide(first.id, "once", "Ada", "");
        expect((yield* Fiber.join(held)).text).toContain("company:acme_tasks_claim");
        expect(writes()).toHaveLength(1);

        // Owners that change while a call waits take its approval away.
        const stale = yield* t.call("acme_tasks_claim", { key: "A-2" }).pipe(Effect.forkChild);
        const second = yield* nextCard;
        yield* t.publish({ tasks: { owner: "off" }, skills: external("acme-gw") });
        yield* approvals.decide(second.id, "once", "Ada", "");
        expect((yield* Fiber.join(stale)).text).toContain("The tool source changed.");
        expect(writes()).toHaveLength(1);
        expect(yield* t.names).not.toContain("acme_tasks_claim");

        // The thread's session token is never sent on, and no credential is invented.
        expect(company.state.calls.every((c) => c.authorization === undefined)).toBe(true);
      }),
    );
  });

  it.live("serves a company's memory with Banneret's memory switch off", () => {
    const threadId = ThreadId.make("thread-memory");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const company = yield* companyServer;
        company.state.tools = ["search", "read", "use", "propose", "flag"].map((verb) =>
          read("acme_banneret_memory_" + verb),
        );
        const t = yield* hub({ threadId, url: company.url });
        yield* t.publish({ memory: external("acme-gw") });
        // The switch is off, which is how every machine starts.
        expect(yield* t.names).toHaveLength(5);
        expect((yield* t.call("acme_banneret_memory_search")).text).toContain("company:");
      }),
    );
  });

  it.live("adds nothing without sources, and drops a source that owns nothing any more", () => {
    const threadId = ThreadId.make("thread-absent");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const company = yield* companyServer;
        company.state.tools = TOOLS;
        const t = yield* hub({ threadId, url: company.url });
        expect(Object.keys((yield* t.issue)?.pluginClaude ?? {})).toEqual(["co-acme-gw"]);
        // Owners with nothing external, then a relay without owners: both as before sources.
        for (const owners of [{ memory: { owner: "off" as const } }, null]) {
          yield* t.publish(owners);
          expect(yield* t.issue).toEqual({ pluginClaude: {}, pluginCodex: {} });
          expect((yield* t.post("tools/list")).status).toBe(404);
          expect(yield* levelHandlers["plugins.levels"]({ threadId })).toEqual([
            { source: "banneret", level: "read_write" },
          ]);
        }
        expect(company.state.calls).toEqual([]);
      }),
    );
  });

  // The owners file as this release writes it. A later release must still load it.
  it.live("loads the saved owners file as written", () => {
    const threadId = ThreadId.make("thread-file");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = (yield* ServerConfig).stateDir + "/banneret/capability-owners";
        yield* fs.makeDirectory(dir, { recursive: true });
        const file = `${dir}/${relayHash(ORIGIN)}.json`;
        yield* fs.writeFileString(
          file,
          '{"key":"https://relay.example.test m_1","owners":{"memory":{"owner":"external","source":"acme-gw","title":"Acme gateway","prefix":""},"chat":{"owner":"off"}},"sources":[{"id":"acme-gw","title":"Acme gateway","url":"https://mcp.example.test/gw","prefix":"","provides":["memory"],"auth":"none"}]}',
        );
        expect((yield* sourcesFor(ORIGIN)).map((source) => source.manifest.source)).toEqual([
          "co-acme-gw",
        ]);
        // A damaged file reads as none, and the thread still starts.
        yield* fs.writeFileString(file, "{");
        expect(yield* sourcesFor(ORIGIN)).toEqual([]);
      }),
    );
  });

  it.live("gives a shared thread no company source", () => {
    const threadId = ThreadId.make("thread-shared");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const company = yield* companyServer;
        yield* hub({ threadId, url: company.url });
        const own = idleThreadProjection(shellOf(threadId)).thread;
        expect(yield* pluginsForThread(own, environmentId)).toHaveLength(1);
        expect(
          yield* pluginsForThread(
            { ...own, linkOrigin: {} as NonNullable<typeof own.linkOrigin> },
            environmentId,
          ),
        ).toEqual([]);
      }),
    );
  });

  it.live("fails a source that lacks a required tool, with one try each turn", () => {
    const threadId = ThreadId.make("thread-shape");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const company = yield* companyServer;
        company.state.tools = TOOLS.filter((tool) => tool.name !== "acme_tasks_claim");
        const t = yield* hub({ threadId, url: company.url });
        const failed = yield* t.rpc("tools/list");
        expect(failed.json.error?.message).toContain(
          "Acme gateway is unavailable in this chat (shape_missing: acme_tasks_claim)",
        );
        const contacted = company.state.calls.length;
        expect((yield* t.call("acme_tasks_read")).text).toContain("shape_missing");
        expect((yield* t.rpc("initialize")).text).toContain("shape_missing");
        expect((yield* t.post("notifications/cancelled", {}, null)).status).toBe(202);
        expect(company.state.calls).toHaveLength(contacted);
        company.state.tools = TOOLS;
        startTurn("turn-2");
        expect(yield* t.names).toContain("acme_tasks_claim");
      }),
    );
  });

  it.live("turns the source's 401 into a sign-in message, never a 401 for the CLI", () => {
    const threadId = ThreadId.make("thread-401");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const company = yield* companyServer;
        company.state.status = 401;
        const t = yield* hub({ threadId, url: company.url });
        const refused = yield* t.rpc("initialize");
        expect(refused.status).toBe(200);
        expect(refused.json.error?.message).toContain("did not accept this machine");
        expect((yield* t.rpc("tools/list")).text).toContain("did not accept this machine");
        expect(company.state.calls).toHaveLength(1);
      }),
    );
  });

  it.live.each(["oauth", "bearer_per_person"] as const)(
    "does not contact a source that needs a sign-in (%s)",
    (auth) => {
      const threadId = ThreadId.make("thread-" + auth);
      return inThread(
        threadId,
        Effect.gen(function* () {
          const company = yield* companyServer;
          const t = yield* hub({ threadId, url: company.url, auth });
          // The entry stays, so signing in later does not change the thread's MCP set.
          expect(Object.keys((yield* t.issue)?.pluginClaude ?? {})).toEqual(["co-acme-gw"]);
          for (const method of ["initialize", "tools/list"])
            expect((yield* t.rpc(method)).json.error?.message).toContain(
              "needs your person to sign in",
            );
          expect(company.state.calls).toEqual([]);
        }),
      );
    },
  );

  it.live("says a company server cannot be reached", () => {
    const threadId = ThreadId.make("thread-down");
    return inThread(
      threadId,
      Effect.gen(function* () {
        // Nothing listens on the discard port.
        const t = yield* hub({ threadId, url: "http://127.0.0.1:9/mcp" });
        const down = yield* t.rpc("initialize");
        expect(down.status).toBe(200);
        expect(down.json.error?.message).toContain("(unreachable)");
      }),
    );
  });
});
