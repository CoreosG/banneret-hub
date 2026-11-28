// @effect-diagnostics globalFetch:off - Streamable HTTP responses pass through as Web streams with redirects disabled.
import { activeRun, answeringAsk } from "../chat/AnswerTurn.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { PreviewAgentActivity } from "../../preview/PreviewAgentActivity.ts";
import { approvalMachine } from "./approvals.ts";
import { forward, storedTransport } from "./transport.ts";
import { memoryEnabled, isPluginMemoryTool } from "../memory/settings.ts";
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
import { isPersonTool, offeredToThread } from "../sources/filters.ts";
import { sourceGate } from "../sources/proxyGate.ts";
import { signInRoute } from "../sources/oauth.ts";

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
  const company = plugin.company;
  const gate = plugin.company ? yield* sourceGate(plugin, invocation.thread.threadId) : undefined;
  if (gate && request.method !== "POST" && gate.closed())
    return HttpServerResponse.empty({ status: 405 });
  const web = yield* HttpServerRequest.toWeb(request);
  let method: string | undefined;
  /** A JSON-RPC error in words; a notification has no reply to carry it. */
  let unavailable = (_message: string) => HttpServerResponse.empty({ status: 405 });
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
    method = rpc.method;
    unavailable = (message) =>
      rpc.id === undefined ? HttpServerResponse.empty({ status: 202 }) : refuse(message);
    const notice = gate?.closed();
    if (notice) return unavailable(notice);
    const thread = invocation.thread.threadId;
    const key = pluginSource(plugin.manifest.source);
    const isAnswering = Effect.gen(function* () {
      const run = yield* activeRun(yield* ThreadManagementService, thread);
      return !!run && !!answeringAsk(run.userMessageId);
    });
    const level = () => levelFor(thread, key);
    // Only a Solo plugin's token is here. A company source's requests go through the gate.
    const soloToken = plugin.company ? "" : plugin.token;
    const listing = (id: string | number | undefined, params: object) =>
      Effect.tryPromise({
        try: async (signal) =>
          catalog(
            await forward(
              web,
              plugin.endpoint,
              soloToken,
              signal,
              encodeEnvelope({ jsonrpc: "2.0", id, method: "tools/list", params }),
            ),
            id,
          ),
        catch: () => "Plugin catalog unavailable" as const,
      });
    // The memory switch is for Banneret's memory. A company's own memory is not Banneret's.
    const isMemoryTool = (name: string) =>
      !company && isPluginMemoryTool(name, plugin.manifest.toolPrefix);
    const shows = (name: string) =>
      !isPersonTool(name) && (!company || offeredToThread(name, company));
    if (rpc.method === "tools/list") {
      let page;
      if (gate) {
        const listed = yield* gate.list(web);
        if (!listed.tools) return unavailable(listed.message);
        page = listed;
      } else {
        page = yield* listing(rpc.id, rpc.params ?? {});
        if (!page.tools) return reply({ error: page.error });
      }
      const current = yield* level();
      const showMemory =
        !page.tools.some((tool) => isMemoryTool(tool.name)) || (yield* memoryEnabled);
      const answering = yield* isAnswering;
      return reply({
        result: {
          ...page.result,
          tools: page.tools.filter(
            (tool) =>
              shows(tool.name) &&
              (showMemory || !isMemoryTool(tool.name)) &&
              allows(current, tool, plugin.manifest.toolPrefix) &&
              (!answering ||
                (tool.annotations?.readOnlyHint === true && !tool.annotations.destructiveHint)),
          ),
        },
      });
    }
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      if (typeof name !== "string") return refuse("Missing tool name.");
      if (!shows(name))
        return refuse(
          isPersonTool(name)
            ? name + " is for a person only. An agent cannot call it."
            : name + " is not offered here. " + plugin.manifest.description + " does not own it.",
        );
      if (isMemoryTool(name) && !(yield* memoryEnabled))
        return refuse("Banneret memory is off on this machine.");
      const activity = yield* PreviewAgentActivity;
      if (!(yield* activity.active(thread))) return refuse(parkedMessage);
      const initial = yield* level();
      if (initial === "none") return refuse(denied(name, plugin.manifest.source, initial));
      let listed: ListedTool | undefined;
      const seen = new Set<string>();
      let cursor: string | undefined;
      if (gate) {
        const all = yield* gate.list(web);
        if (!all.tools) return unavailable(all.message);
        listed = all.tools.find((t) => t.name === name);
      } else
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
      if (kind !== "read" || (listed.annotations?.readOnlyHint !== true && (yield* isAnswering))) {
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
      // Local skills fill in for a Solo plugin only. A company's skills are what its server says.
      const result =
        !plugin.company && plugin.manifest.capabilities.includes("skills")
          ? yield* skillReply(web, plugin, invocation.thread, permission)
          : undefined;
      const reason = yield* permission(listed);
      if (reason) return refuse(reason);
      if (result) return result;
    }
  }
  if (gate) {
    const sent =
      method === "initialize" ? yield* gate.initialize(web, body!) : yield* gate.send(web, body);
    return sent.response ? HttpServerResponse.fromWeb(sent.response) : unavailable(sent.message);
  }
  const token = plugin.company ? "" : plugin.token;
  const response = yield* Effect.tryPromise({
    try: (signal) => forward(web, plugin.endpoint, token, signal, body),
    catch: () => "Plugin unavailable" as const,
  });
  return HttpServerResponse.fromWeb(response);
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 502 })));

const proxyRoute = HttpRouter.add("*", "/banneret/plugins/:source", proxy).pipe(
  HttpRouter.provideRequest(
    Layer.mergeAll(
      Layer.effect(ProjectionStore.ProjectionStoreV2, ProjectionStore.ProjectionStoreV2),
      Layer.effect(ThreadManagementService, ThreadManagementService),
      Layer.effect(PreviewAgentActivity, PreviewAgentActivity),
    ),
  ),
);
export const pluginRoute = Layer.merge(proxyRoute, signInRoute);
