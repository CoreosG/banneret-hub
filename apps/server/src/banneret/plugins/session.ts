import type { OrchestrationV2AppThread, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ServerConfig } from "../../config.ts";
import * as Registry from "../../mcp/McpSessionRegistry.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { threadWorkspace } from "./workspace.ts";
import { readPlugins } from "./registry.ts";
import { sourcesFor, type ThreadSource } from "../sources/ThreadSources.ts";

export const threadPlugins = Effect.fn("SoloPlugins.thread")(function* (
  threadId: ThreadId,
  environmentId: EnvironmentId,
) {
  const thread = yield* (yield* ProjectionStoreV2).getThread(threadId);
  return yield* pluginsForThread(thread, environmentId);
});
/** A Solo plugin, or with `company` set, a company source of an Enterprise workspace. */
export type ThreadPlugin =
  | (Effect.Success<ReturnType<typeof readPlugins>>[number] & { readonly company?: undefined })
  | ThreadSource;
export const pluginsForThread = Effect.fn(function* (
  thread: OrchestrationV2AppThread,
  environmentId: EnvironmentId,
) {
  if (!thread || thread.guestShare || thread.linkOrigin || thread.deletedAt || thread.archivedAt)
    return [] as ReadonlyArray<ThreadPlugin>;
  const owner = (yield* threadWorkspace(thread.id, thread.projectId, environmentId))?.owner;
  const plugins: ReadonlyArray<ThreadPlugin> =
    owner?.kind === "solo"
      ? yield* readPlugins(owner.id)
      : owner?.relay
        ? yield* sourcesFor(owner.relay.origin)
        : [];
  return plugins;
});

export type McpSessionRegistry = Registry.McpSessionRegistry;
export const McpSessionRegistry = Effect.gen(function* () {
  const registry = yield* Registry.McpSessionRegistry;
  const project = yield* Effect.serviceOption(ProjectService);
  const config = yield* Effect.serviceOption(ServerConfig);
  const path = yield* Effect.serviceOption(Path.Path);
  const random = yield* Effect.serviceOption(SecureRandom.SecureRandom);
  if (
    Option.isNone(project) ||
    Option.isNone(config) ||
    Option.isNone(path) ||
    Option.isNone(random)
  )
    return registry;
  const services = yield* Effect.context<
    import("effect/FileSystem").FileSystem | ProjectionStoreV2
  >();
  return {
    ...registry,
    issue: Effect.fn("SoloPlugins.issue")(function* (request: Registry.McpCredentialRequest) {
      const issued = yield* registry.issue(request);
      const session = issued.config;
      const plugins = yield* threadPlugins(request.threadId, session.environmentId).pipe(
        Effect.provideService(ProjectService, project.value),
        Effect.provideService(ServerConfig, config.value),
        Effect.provideService(Path.Path, path.value),
        Effect.provideService(SecureRandom.SecureRandom, random.value),
        Effect.provideContext(services),
        Effect.orElseSucceed(() => []),
      );
      const servers = plugins.map(({ manifest, company }) => {
        const url = new URL("/banneret/plugins/" + manifest.source, session.endpoint).href;
        const headers = { Authorization: session.authorizationHeader };
        return {
          // A company source keeps the `co-<source>` name the join file and task linking use.
          name: company ? manifest.source : "banneret-plugin-" + manifest.source,
          claude: { type: "http" as const, url, headers },
          codex: { url, http_headers: headers },
        };
      });
      return {
        config: {
          ...session,
          soloPlugins: {
            pluginClaude: Object.fromEntries(servers.map((s) => [s.name, s.claude])),
            pluginCodex: Object.fromEntries(servers.map((s) => ["mcp_servers." + s.name, s.codex])),
          },
        },
      };
    }),
  };
});
