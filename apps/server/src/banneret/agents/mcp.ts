// Banneret Hub: the agent toolkit and join resource on the Hub's own MCP server (docs/banneret/agents.md).
// A per-thread visibility hides them from every thread its company's relay does not offer them to, on lists and
// on calls alike, so a Solo thread neither sees nor reaches them. The handlers still check the thread themselves.
// The only fork file that touches Effect's McpServer directly: tools still go through McpToolAccess.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import type * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as AgentRelays from "./AgentRelays.ts";
import * as AgentHandlers from "./handlers.ts";
import { JOIN_URI, joinText } from "./join.ts";
import { AgentToolkit } from "./tools.ts";

/**
 * Visible when the calling thread is offered the tool, or, for the join resource, any tool. A check that
 * failed would fail the whole list request, so every failure reads as hidden.
 */
const offeredOnly = McpServer.visibility(
  Effect.gen(function* () {
    const relays = yield* AgentRelays.BanneretAgentRelays;
    return ({ target }: McpServer.MiddlewareOptions) =>
      Effect.gen(function* () {
        const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
        const thread = Option.getOrUndefined(scope)?.thread;
        if (thread === undefined) return false;
        const offered = yield* relays.offered(thread.threadId);
        return target === JOIN_URI ? offered.size > 0 : offered.has(target);
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));
  }),
);

const joinResource = Layer.effectDiscard(
  Effect.gen(function* () {
    const relays = yield* AgentRelays.BanneretAgentRelays;
    yield* McpServer.registerResource({
      uri: JOIN_URI,
      name: "banneret_join",
      description: "The company's lease rules for coding agents. Read before you change anything.",
      mimeType: "text/markdown",
      annotations: Context.make(
        McpSchema.EnabledWhen,
        McpInvocationContext.hiddenFromOutsideClients,
      ),
      content: Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const relay =
          scope.thread === undefined ? null : yield* relays.forThread(scope.thread.threadId);
        if (relay === null) {
          return yield* new McpSchema.InvalidParams({
            message: "This thread is not in a company workspace, so no lease rules apply.",
          });
        }
        return joinText({ company: relay.company, login: relay.me.login });
      }).pipe(
        Effect.catchTags({
          OrchestratorMcpFailure: (error) =>
            Effect.fail(new McpSchema.InternalError({ message: error.message })),
        }),
      ),
    });
  }),
).pipe(Layer.provide(McpServer.McpServer.layer));

/**
 * The toolkit and the join resource, for McpHttpServer's `layer` to register beside upstream's tools. It takes
 * `toolkitRegistration` as an argument so this module never imports McpHttpServer, which imports it.
 */
export const layer = (register: typeof McpHttpServer.toolkitRegistration) =>
  Layer.mergeAll(register(AgentToolkit, AgentHandlers.layer), joinResource).pipe(
    Layer.provide(offeredOnly.layer),
    Layer.provide(AgentRelays.layer),
  );
