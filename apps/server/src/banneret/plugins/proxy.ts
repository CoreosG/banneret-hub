// @effect-diagnostics globalFetch:off - Streamable HTTP responses pass through as Web streams with redirects disabled.
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { PreviewAgentActivity } from "../../preview/PreviewAgentActivity.ts";
import { approvalMachine } from "./approvals.ts";
import { forward, storedTransport } from "./transport.ts";
import { catalog } from "./catalog.ts";
import {
  classify,
  levelFor,
  pluginSource,
  parkedMessage,
  denied,
  allows,
  type ListedTool,
} from "./levels.ts";
import { skillReply } from "./skills.ts";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { threadPlugins } from "./session.ts";

const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
    method: Schema.String,
    params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const encodeEnvelope = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
  let body: string | undefined;
  if (request.method === "POST") {
    const data = yield* Effect.promise(() =>
      web
        .clone()
        .json()
        .catch(() => null),
    );
    body = encodeEnvelope(data);
    const rpc = Option.getOrUndefined(decodeEnvelope(data));
    const reply = (payload: object) =>
      HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: rpc?.id ?? null, ...payload });
    const refuse = (message: string) => reply({ error: { code: -32602, message } });
    if (!rpc) return refuse("Expected one MCP request.");
    const thread = invocation.thread.threadId;
    const key = pluginSource(plugin.manifest.source);
    const level = () => levelFor(thread, key);
    const listing = (id: string | number | undefined, params: object) =>
      Effect.tryPromise({
        try: async (signal) =>
          catalog(
            await forward(
              web,
              plugin.endpoint,
              plugin.token,
              signal,
              encodeEnvelope({ jsonrpc: "2.0", id, method: "tools/list", params }),
            ),
            id,
          ),
        catch: () => "Plugin catalog unavailable" as const,
      });
    if (rpc.method === "tools/list") {
      const page = yield* listing(rpc.id, rpc.params ?? {});
      if (!page.tools) return reply({ error: page.error });
      const current = yield* level();
      return reply({
        result: {
          ...page.result,
          tools: page.tools.filter((tool) => allows(current, tool, plugin.manifest.toolPrefix)),
        },
      });
    }
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      if (typeof name !== "string") return refuse("Missing tool name.");
      const activity = yield* PreviewAgentActivity;
      if (!(yield* activity.active(thread))) return refuse(parkedMessage);
      const initial = yield* level();
      if (initial === "none") return refuse(denied(name, plugin.manifest.source, initial));
      let listed: ListedTool | undefined;
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const id = yield* (yield* SecureRandom.SecureRandom).uuidV4();
        const page = yield* listing(id, cursor ? { cursor } : {});
        listed = page.tools?.find((t) => t.name === name);
        if (listed) break;
        cursor = page.cursor;
        if (!cursor || seen.has(cursor) || seen.size >= 100) break;
        seen.add(cursor);
      } while (true);
      if (!listed || !allows(initial, listed, plugin.manifest.toolPrefix))
        return refuse(denied(name, plugin.manifest.source, initial));
      const kind = classify(listed, plugin.manifest.toolPrefix);
      if (kind !== "read") {
        const machine = yield* approvalMachine(invocation.environmentId);
        const result = yield* machine.submit(
          invocation,
          key,
          name,
          rpc.params?.arguments,
          kind === "sensitive",
          storedTransport(web, plugin.endpoint, body!),
        );
        return reply({ result });
      }
      const permission = Effect.fn("ThreadTools.readPermission")(function* (tool: ListedTool) {
        const current = yield* level();
        if (!(yield* activity.active(thread))) return parkedMessage;
        if (current === "none" || classify(tool, plugin.manifest.toolPrefix) !== "read")
          return denied(tool.name, plugin.manifest.source, current);
      });
      const result = plugin.manifest.capabilities.includes("skills")
        ? yield* skillReply(web, plugin, invocation.thread, permission)
        : undefined;
      const reason = yield* permission(listed);
      if (reason) return refuse(reason);
      if (result) return result;
    }
  }
  const response = yield* Effect.tryPromise({
    try: (signal) => forward(web, plugin.endpoint, plugin.token, signal, body),
    catch: () => "Plugin unavailable" as const,
  });
  return HttpServerResponse.fromWeb(response);
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 502 })));

export const pluginRoute = HttpRouter.add("*", "/banneret/plugins/:source", proxy).pipe(
  HttpRouter.provideRequest(
    Layer.merge(
      Layer.effect(ProjectionStore.ProjectionStoreV2, ProjectionStore.ProjectionStoreV2),
      Layer.effect(PreviewAgentActivity, PreviewAgentActivity),
    ),
  ),
);
