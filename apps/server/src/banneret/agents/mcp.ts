// Banneret Hub: the agent toolkit and join resource on the Hub's own MCP server (docs/banneret/agents.md).
// A per-thread visibility hides them from every thread its company's relay does not offer them to, on lists and
// on calls alike, so a Solo thread neither sees nor reaches them. The handlers still check the thread themselves.
// The only fork file that touches Effect's McpServer directly: tools still go through McpToolAccess.
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import type * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as AgentRelays from "./AgentRelays.ts";
import * as AgentHandlers from "./handlers.ts";
import { JOIN_URI, joinText } from "./join.ts";
import { taskPrompts } from "./startTask.ts";
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
        return taskPrompts.some((p) => p.name === target)
          ? offered.has("banneret_lease_take")
          : target === JOIN_URI
            ? offered.size > 0
            : offered.has(target);
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));
  }),
);

const joinResource = Layer.effectDiscard(
  Effect.gen(function* () {
    const relays = yield* AgentRelays.BanneretAgentRelays;
    for (const prompt of taskPrompts)
      yield* McpServer.registerPrompt({
        name: prompt.name,
        description: prompt.description,
        annotations: Context.make(
          McpSchema.EnabledWhen,
          McpInvocationContext.hiddenFromOutsideClients,
        ),
        content: () => Effect.succeed(prompt.text),
      });
    yield* McpServer.registerResource({
      uri: JOIN_URI,
      name: "banneret_join",
      description:
        "The company's lease and chat rules for coding agents. Read before you change anything.",
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
 * Sends list_changed when an offer's inputs move, so a thread that listed before the Hub read the relay's
 * capabilities still gets the tools. One in-memory state, the last inputs, read at layer start. Upstream
 * sends it to every session with a notification stream, not only the ones whose offer changed.
 */
const relistOnOfferChange = (every: Duration.Input) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const relays = yield* AgentRelays.BanneretAgentRelays;
      const server = yield* McpServer.McpServer;
      let last = yield* relays.offerInputs;
      yield* Effect.sleep(every).pipe(
        Effect.andThen(relays.offerInputs),
        Effect.flatMap((next) => {
          if (next === undefined || next === last) return Effect.void;
          last = next;
          // Forget kept offers first, so the list this notice prompts reads the new offer.
          return Effect.andThen(
            relays.forgetOffers,
            server.notifications["notifications/tools/list_changed"]({}),
          );
        }),
        // One failed tick must not end the loop.
        Effect.catchCause((cause) => Effect.logWarning("Banneret agent relist failed", cause)),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  ).pipe(Layer.provide(McpServer.McpServer.layer));

/**
 * The toolkit and the join resource, for McpHttpServer's `layer` to register beside upstream's tools. It takes
 * `toolkitRegistration` as an argument so this module never imports McpHttpServer, which imports it.
 * `relistEvery` is how often offers are checked for a change (tests shorten it).
 */
export const layer = (
  register: typeof McpHttpServer.toolkitRegistration,
  options: { readonly relistEvery?: Duration.Input } = {},
) =>
  Layer.mergeAll(
    register(AgentToolkit, AgentHandlers.layer),
    joinResource,
    relistOnOfferChange(options.relistEvery ?? "5 seconds"),
  ).pipe(Layer.provide(offeredOnly.layer), Layer.provide(AgentRelays.layer));
