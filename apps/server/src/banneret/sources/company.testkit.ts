// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalJsonInEffect:off - a local company MCP server.
// What the company source tests share: a joined Enterprise thread behind the Hub's plugin proxy. The
// layers carry no relay feed, as the layer that issues a thread's MCP set carries none in the real server.

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ElsewhereOwners,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as Registry from "../../mcp/McpSessionRegistry.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as Activity from "../../preview/PreviewAgentActivity.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { approvalLifecycle } from "../plugins/approvals.ts";
import { pluginRoute } from "../plugins/proxy.ts";
import { McpSessionRegistry } from "../plugins/session.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { BanneretEnrolment } from "../relay/Enrolment.ts";
import { put } from "../Workspaces.ts";
import { writeSavedOwnership, type SavedSource } from "./ownership.ts";

export const environmentId = EnvironmentId.make("sources-test");
const providerInstanceId = ProviderInstanceId.make("codex");
export const ORIGIN = "https://relay.example.test";
/** The run the thread is in; a test moves it to start the next turn. */
let run = RunId.make("turn-1");
export const startTurn = (name: string) => {
  run = RunId.make(name);
};

export const shellOf = (id: ThreadId) => ({ ...liveThreadShell(id), activeRunId: run });

const layersFor = (threadId: ThreadId) =>
  Layer.mergeAll(
    Activity.layer,
    Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
    Layer.mock(ProjectionStoreV2)({
      getThreadShell: () => Effect.sync(() => shellOf(threadId)),
      getThread: () => Effect.sync(() => idleThreadProjection(shellOf(threadId)).thread),
    }),
    Layer.mock(ThreadManagementService)({
      getThreadShell: () => Effect.sync(() => shellOf(threadId)),
      getThreadRecords: () => Effect.sync(() => idleThreadProjection(shellOf(threadId))),
    }),
    Layer.mock(ProjectService)({
      getShell: () =>
        Effect.succeedSome({
          workspaceRoot: "/project",
          repositoryIdentity: null,
        } as OrchestrationProjectShell),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
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
    ServerConfig.layerTest(process.cwd(), { prefix: "sources-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer));

export const external = (source: string) =>
  ({ owner: "external", source, title: "Acme gateway", prefix: "acme_" }) as const;

export const read = (name: string) => ({ name, annotations: { readOnlyHint: true } });
export const TOOLS = [
  read("acme_tasks_list_boards"),
  read("acme_tasks_list_tasks"),
  read("acme_tasks_read"),
  { name: "acme_tasks_claim" },
  { name: "acme_tasks_release" },
  read("acme_skills_list"),
  read("acme_skills_get"),
  read("acme_memory_search"),
  read("memory_person_list"),
  { name: "acme_memory_person_confirm" },
  read("acme_deploy_status"),
  { name: "acme_delete_database" },
];

interface HubInput {
  threadId: ThreadId;
  url: string;
  auth?: SavedSource["auth"];
}

/**
 * Joins an Enterprise workspace whose relay published these owners, and serves the proxy. The test
 * file passes `McpServer.McpServer`: only test files may name it.
 */
export const makeHub = (mcp: typeof McpServer.McpServer) =>
  Effect.fn("Test.hub")(function* (input: HubInput) {
    run = RunId.make("turn-1");
    yield* put({
      workspaces: [
        {
          id: "ent-acme",
          name: "Acme",
          kind: "enterprise",
          updatedAt: "2026-01-01T00:00:00Z",
          projectKeys: ["path:sources-test:/project"],
          relay: { origin: ORIGIN, displayName: "Acme" },
        },
      ],
    });
    const source: SavedSource = {
      id: "acme-gw",
      title: "Acme gateway",
      url: input.url,
      prefix: "acme_",
      provides: ["tasks", "skills", "memory"],
      auth: input.auth ?? "none",
    };
    /** What the relay feed saves after reading capabilities with these owners. */
    const publish = (owners: ElsewhereOwners | null, named: SavedSource = source) => {
      const external = Object.values(owners ?? {}).some((owner) => owner.owner === "external");
      return writeSavedOwnership(
        ORIGIN,
        owners && { key: `${ORIGIN} m_1`, owners, sources: external ? [named] : [] },
      );
    };
    yield* publish({ tasks: external("acme-gw"), skills: external("acme-gw") });

    const activity = yield* Activity.PreviewAgentActivity;
    const endTurn = yield* activity.begin(input.threadId);
    yield* Effect.addFinalizer(() => endTurn);
    yield* HttpRouter.serve(Layer.merge(pluginRoute, approvalLifecycle(mcp)), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.build);
    const registry = yield* McpSessionRegistry;
    const issue = Effect.gen(function* () {
      const issued = yield* registry.issue({ threadId: input.threadId, providerInstanceId });
      return (issued.config as McpProviderSessionConfig).soloPlugins;
    });
    const http = yield* HttpClient.HttpClient;
    /** Without an id the message is a notification. */
    const post = (method: string, params: object = {}, id: number | null = 2) =>
      http.post("/banneret/plugins/co-acme-gw", {
        headers: {
          authorization: "Bearer session",
          accept: "application/json, text/event-stream",
        },
        body: HttpBody.text(
          JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
          "application/json",
        ),
      });
    const rpc = (method: string, params: object = {}) =>
      post(method, params).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (text) => ({
            status: response.status,
            text,
            json: JSON.parse(text) as {
              result?: { tools?: ReadonlyArray<{ name: string }>; nextCursor?: string };
              error?: { message: string };
            },
          })),
        ),
      );
    return {
      source,
      endTurn,
      issue,
      publish,
      post,
      rpc,
      names: rpc("tools/list").pipe(
        Effect.map((reply) => (reply.json.result?.tools ?? []).map((tool) => tool.name)),
      ),
      call: (name: string, args: object = {}) => rpc("tools/call", { name, arguments: args }),
    };
  });

export const inThread = <A, E, R>(threadId: ThreadId, body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(layersFor(threadId), NodeHttpServer.layerTest)),
  );
