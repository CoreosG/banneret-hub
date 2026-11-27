// @effect-diagnostics globalFetch:off - Streamable HTTP responses pass through as Web streams with redirects disabled.
import { skillReply } from "./skills.ts";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { threadPlugins } from "./session.ts";

const proxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = request.headers.authorization;
  if (request.headers.origin || !auth?.startsWith("Bearer "))
    return HttpServerResponse.empty({ status: 403 });
  const invocation = yield* (yield* McpSessionRegistry).resolve(auth.slice(7));
  if (!invocation) return HttpServerResponse.empty({ status: 401 });
  const source = (yield* HttpRouter.params).source;
  const plugins = yield* threadPlugins(invocation.thread.threadId, invocation.environmentId);
  const plugin = plugins.find((p) => p.manifest.source === source);
  if (!plugin) return HttpServerResponse.empty({ status: 404 });
  const web = yield* HttpServerRequest.toWeb(request);
  if (request.method === "POST" && plugin.manifest.capabilities.includes("skills")) {
    const reply = yield* skillReply(web, plugin, invocation.thread);
    if (reply) return reply;
  }
  const response = yield* Effect.tryPromise({
    try: (signal) => forward(web, plugin.endpoint, plugin.token, signal),
    catch: () => "Plugin unavailable" as const,
  });
  return HttpServerResponse.fromWeb(response);
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 502 })));

async function forward(request: Request, endpoint: string, token: string, signal: AbortSignal) {
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (token) headers.set("Authorization", "Bearer " + token);
  const response = await fetch(endpoint, {
    method: request.method,
    headers,
    redirect: "error",
    signal,
    ...(request.method === "POST" ? { body: await request.arrayBuffer() } : {}),
  });
  const returned = new Headers();
  for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version"]) {
    const value = response.headers.get(name);
    if (value) returned.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: returned });
}
export const pluginRoute = HttpRouter.add("*", "/banneret/plugins/:source", proxy).pipe(
  HttpRouter.provideRequest(
    Layer.effect(ProjectionStore.ProjectionStoreV2, ProjectionStore.ProjectionStoreV2),
  ),
);
