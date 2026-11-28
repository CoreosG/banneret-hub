// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - exercises local manifest and MCP servers.
import { NodeHttpServer } from "@effect/platform-node";
import { HttpRouter, HttpClient, HttpBody } from "effect/http";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as Activity from "../../preview/PreviewAgentActivity.ts";
import { setLevel, pluginSource } from "./levels.ts";
import { pluginRoute } from "./proxy.ts";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Redacted from "effect/Redacted";
import { ServerConfig } from "../../config.ts";
import * as Registry from "../../mcp/McpSessionRegistry.ts";
import { liveThreadShell, idleThreadProjection } from "../../mcp/McpToolAccess.testkit.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { memoryAccess } from "../memory/access.ts";
import { put } from "../Workspaces.ts";
import { pluginHandlers } from "./registry.ts";
import { McpSessionRegistry } from "./session.ts";
import { BanneretEnrolment } from "../relay/Enrolment.ts";

const templateEndpoint = process.env.BANNERET_TEMPLATE_MCP;
const templateManifest = process.env.BANNERET_TEMPLATE_MANIFEST;
const manifest = {
  source: "starter",
  description: "An in-memory board, skill library and notebook",
  capabilities: ["tasks", "skills", "memory"],
  auth: "per-user-token",
  atomicClaim: true,
};
const environmentId = EnvironmentId.make("plugin-test");
const threadId = ThreadId.make("test-chat");
const providerInstanceId = ProviderInstanceId.make("codex");
const thread = liveThreadShell(threadId);
const layers = Layer.mergeAll(
  Activity.layer,
  Layer.mock(ProjectionStoreV2)({
    getThreadShell: () => Effect.succeed(thread),
    getThread: () => Effect.succeed(idleThreadProjection(thread).thread),
  }),
  Layer.mock(ThreadManagementService)({
    getThreadRecords: () => Effect.succeed(idleThreadProjection(thread)),
  }),
  Layer.mock(ProjectService)({
    getShell: () =>
      Effect.succeedSome({
        workspaceRoot: "/project",
        repositoryIdentity: null,
      } as OrchestrationProjectShell),
  }),
  Layer.mock(ProviderRegistry)({
    getProviders: Effect.succeed([
      {
        instanceId: providerInstanceId,
        skills: [
          { name: "review", description: "Local review", path: "/unused", enabled: true },
          { name: "local-only", description: "Local skill", path: "/unused", enabled: true },
        ],
      } as unknown as ServerProvider,
    ]),
  }),
  Layer.mock(Registry.McpSessionRegistry)({
    resolve: (token) =>
      Effect.succeed(
        token === "session"
          ? {
              environmentId,
              requestNamespace: "test",
              thread: { threadId, providerInstanceId, providerSessionId: "session" },
              issuedAt: 0,
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
            }
          : undefined,
      ),
    issue: () =>
      Effect.succeed({
        config: {
          environmentId,
          threadId,
          providerInstanceId,
          providerSessionId: "session",
          endpoint: "http://localhost/mcp",
          authorizationHeader: "Bearer session",
          browserToolsAvailable: false,
        },
      }),
  }),
  Layer.succeed(BanneretEnrolment, BanneretEnrolment.defaultValue()),
  ServerConfig.layerTest(process.cwd(), { prefix: "pl11-" }),
).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer));

it.live(
  "installs a manifest, issues scoped servers, replaces local memory and restores it on removal",
  () =>
    Effect.gen(function* () {
      const headers: string[] = [];
      const activity = yield* Activity.PreviewAgentActivity;
      const park = yield* activity.begin(threadId);
      const fixture = yield* Effect.acquireDisposable(
        Effect.promise(async () => {
          const server = NodeHttp.createServer(async (request, response) => {
            headers.push(request.headers.authorization ?? "");
            response.setHeader("content-type", "application/json");
            if (request.url === "/mcp") {
              if (request.headers.authorization !== "Bearer demo-alice")
                response.writeHead(401).end();
              else {
                const chunks = [];
                for await (const chunk of request) chunks.push(chunk);
                const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                response.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: rpc.id,
                    result:
                      rpc.method === "tools/call"
                        ? { content: [] }
                        : { tools: [{ name: "skills_get" }, { name: "delete_issue" }] },
                  }),
                );
              }
            } else response.end(JSON.stringify(manifest));
          });
          await new Promise<void>((resolve, reject) =>
            server.once("error", reject).listen(0, "127.0.0.1", resolve),
          );
          return server;
        }),
      );
      const addr = fixture.address();
      if (!addr || typeof addr === "string") throw new Error("Missing fixture port");
      const endpoint = templateEndpoint ?? `http://127.0.0.1:${addr.port}/mcp`;
      const manifestUrl = templateManifest ?? `http://127.0.0.1:${addr.port}/plugin.json`;
      const workspaceId = "solo";
      yield* put({
        workspaces: [
          {
            id: workspaceId,
            name: "Solo",
            kind: "solo",
            updatedAt: "2026-01-01T00:00:00Z",
            projectKeys: ["path:plugin-test:/project"],
          },
        ],
      });
      const registry = yield* McpSessionRegistry;
      const issue = registry.issue({ threadId, providerInstanceId });
      const settings = yield* pluginHandlers["plugins.add"]({
        workspaceId,
        endpoint,
        manifestUrl,
        token: Redacted.make("demo-alice"),
      });
      expect(settings).toMatchObject([
        { source: "starter", capabilities: ["tasks", "skills", "memory"], auth: "per-user-token" },
      ]);
      expect(JSON.stringify(settings)).not.toContain("demo-alice");
      if (!templateManifest) expect(headers).toEqual([""]);
      const { config } = yield* issue;
      expect(config.soloPlugins?.pluginClaude).toHaveProperty("banneret-plugin-starter");
      expect(Object.keys(config.soloPlugins?.pluginCodex ?? {})).toEqual([
        "mcp_servers.banneret-plugin-starter",
      ]);
      expect(JSON.stringify(config)).not.toContain("demo-alice");
      yield* HttpRouter.serve(pluginRoute, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.build,
      );
      const http = yield* HttpClient.HttpClient;
      const server = config.soloPlugins?.pluginClaude?.["banneret-plugin-starter"];
      if (!server) throw new Error("Missing session plugin");
      const send = (
        token: string,
        body = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
      ) =>
        http.post(new URL(server.url).pathname, {
          headers: { authorization: token, accept: "application/json, text/event-stream" },
          body: HttpBody.text(body, "application/json"),
        });
      expect((yield* send("Bearer invalid")).status).toBe(401);
      const listing = yield* send(server.headers.Authorization!);
      expect(listing.status).toBe(200);
      expect(yield* listing.text).toContain("skills_get");
      yield* setLevel(threadId, pluginSource("starter"), "read");
      const call = (name: string) =>
        send(
          server.headers.Authorization!,
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name, arguments: {} },
          }),
        );
      const readList = yield* (yield* send(server.headers.Authorization!)).text;
      expect(readList).toContain("skills_get");
      expect(readList).not.toContain("delete_issue");
      if (!templateEndpoint)
        expect(yield* (yield* call("skills_get")).json).toMatchObject({ result: { content: [] } });
      expect(yield* (yield* call("delete_issue")).text).toContain("is set to read");
      yield* park;
      expect(yield* (yield* send(server.headers.Authorization!)).text).toContain("skills_get");
      expect(yield* (yield* call("skills_get")).text).toContain("parked between turns");
      const endTurn = yield* activity.begin(threadId);
      yield* Effect.addFinalizer(() => endTurn);
      yield* setLevel(threadId, pluginSource("starter"), "none");
      expect(yield* (yield* call("skills_get")).text).toContain("is set to none");
      yield* setLevel(threadId, pluginSource("starter"), "read_write");
      if (templateEndpoint) {
        const skills = yield* send(
          server.headers.Authorization!,
          '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"skills_list","arguments":{}}}',
        );
        expect(skills.status).toBe(200);
        expect(yield* skills.json).toMatchObject({
          result: {
            structuredContent: {
              skills: [
                { name: "review", description: "Review a change" },
                { name: "local-only", description: "Local skill" },
              ],
            },
          },
        });
      }
      expect(yield* Effect.isSuccess(memoryAccess(threadId, environmentId))).toBe(false);
      expect(yield* pluginHandlers["plugins.remove"]({ workspaceId, source: "starter" })).toEqual(
        [],
      );
      expect((yield* send(server.headers.Authorization!)).status).toBe(404);
      expect((yield* issue).config.soloPlugins?.pluginClaude).toEqual({});
      expect(yield* Effect.isSuccess(memoryAccess(threadId, environmentId))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layers, NodeHttpServer.layerTest))),
);
