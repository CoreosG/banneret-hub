import { defaults, skillCatalog } from "../skills/catalog.ts";
import * as Schema from "effect/Schema";
import { knowledgeRevision } from "../memory/KbIndex.ts";
import { memoryAccess, offersHubMemory } from "../memory/access.ts";
import * as SandboxHandoff from "./SandboxHandoff.ts";
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
import { JOIN_URI, joinText, skillRules } from "./join.ts";
import { taskPrompts } from "./startTask.ts";
import { AgentToolkit, memoryNames, skillNames } from "./tools.ts";

/**
 * Visible when the calling thread is offered the tool, or, for the join resource, any tool. A check that
 * failed would fail the whole list request, so every failure reads as hidden.
 */
const offeredOnly = McpServer.visibility(
  Effect.gen(function* () {
    const relays = yield* AgentRelays.BanneretAgentRelays;
    const memoryContext = yield* Effect.context<Effect.Services<ReturnType<typeof memoryAccess>>>();
    return ({ target }: McpServer.MiddlewareOptions) =>
      Effect.gen(function* () {
        const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
        const caller = Option.getOrUndefined(scope);
        const thread = caller?.thread;
        if (!caller || !thread) return false;
        if (
          target === "banneret_skills_propose" &&
          !(yield* offersHubMemory(thread.threadId, caller.environmentId).pipe(
            Effect.provideContext(memoryContext),
          ))
        )
          return false;
        if (skillNames.includes(target) || target.startsWith("skill://"))
          return yield* memoryAccess(thread.threadId, caller.environmentId, "skills").pipe(
            Effect.as(true),
            Effect.provideContext(memoryContext),
          );
        if (target === "banneret_kb_search")
          return yield* memoryAccess(thread.threadId, caller.environmentId).pipe(
            Effect.flatMap((a) => a.open((s) => s.folders().length > 0)),
            Effect.provideContext(memoryContext),
          );
        if (memoryNames.includes(target))
          return yield* offersHubMemory(thread.threadId, caller.environmentId).pipe(
            Effect.provideContext(memoryContext),
          );
        const offered = yield* relays.offered(thread.threadId);
        if (target === JOIN_URI && offered.size === 0)
          return yield* memoryAccess(thread.threadId, caller.environmentId, "skills").pipe(
            Effect.as(true),
            Effect.catch(() =>
              memoryAccess(thread.threadId, caller.environmentId).pipe(
                Effect.map((a) => a.orchestrator),
              ),
            ),
            Effect.provideContext(memoryContext),
          );
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
    const memoryContext = yield* Effect.context<Effect.Services<ReturnType<typeof memoryAccess>>>();
    const skillResource = Effect.fn("BanneretSkills.resource")(function* (name: string) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.thread)
        return yield* new McpSchema.InvalidParams({ message: "A Hub thread is required." });
      const { skills } = yield* skillCatalog(scope.thread.threadId, scope.environmentId).pipe(
        Effect.provideContext(memoryContext),
      );
      const skill = skills.get(name);
      if (!skill) return yield* new McpSchema.InvalidParams({ message: "Unknown skill." });
      return skill.text;
    });
    const skillOptions = {
      mimeType: "text/markdown",
      annotations: Context.make(
        McpSchema.EnabledWhen,
        McpInvocationContext.hiddenFromOutsideClients,
      ),
    };
    for (const skill of defaults)
      yield* McpServer.registerResource({
        ...skillOptions,
        name: skill.name,
        uri: `skill://${skill.name}/`,
        content: skillResource(skill.name),
      });
    yield* McpServer.registerResource`skill://${Schema.String}/`({
      ...skillOptions,
      name: "workspace-skill",
      content: (_uri, name) => skillResource(name),
    });
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
        "Read at session start for company rules and the private memory index in orchestrator chats.",
      mimeType: "text/markdown",
      annotations: Context.make(
        McpSchema.EnabledWhen,
        McpInvocationContext.hiddenFromOutsideClients,
      ),
      content: Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (!scope.thread)
          return yield* new McpSchema.InvalidParams({ message: "A Hub thread is required." });
        const id = scope.thread.threadId;
        const offered = yield* relays.offered(id);
        const relay = offered.size ? yield* relays.forThread(id) : null;
        const index = yield* memoryAccess(id, scope.environmentId).pipe(
          Effect.provideContext(memoryContext),
          Effect.flatMap((access) =>
            access.orchestrator ? access.open((store) => store.index()) : Effect.succeed(""),
          ),
          Effect.orElseSucceed(() => ""),
        );
        const skillsOffered = yield* memoryAccess(id, scope.environmentId, "skills").pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
          Effect.provideContext(memoryContext),
        );
        if (!relay && !index && !skillsOffered)
          return yield* new McpSchema.InvalidParams({
            message: "No join resource for this thread.",
          });
        return [
          relay && joinText({ company: relay.company, login: relay.me.login }),
          !relay && skillsOffered && skillRules,
          index,
        ]
          .filter(Boolean)
          .join("\n\n");
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
      let lastKnowledge = knowledgeRevision;
      yield* Effect.sleep(every).pipe(
        Effect.andThen(relays.offerInputs),
        Effect.flatMap((next) => {
          if ((next === undefined || next === last) && lastKnowledge === knowledgeRevision)
            return Effect.void;
          lastKnowledge = knowledgeRevision;
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
    SandboxHandoff.lifecycle,
    relistOnOfferChange(options.relistEvery ?? "5 seconds"),
  ).pipe(Layer.provide(offeredOnly.layer), Layer.provide(AgentRelays.layer));
export { pluginRoute } from "../plugins/proxy.ts";
export { withSkillResources } from "../skills/resources.ts";
