import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as Orchestrators from "../mcp/OrchestratorMcpService.ts";
import { readDesignations } from "./OrchestratorState.ts";
import * as Workspaces from "./Workspaces.ts";

// Peer forwarding uses the same thread list as a local caller.
export const layer = Layer.effect(
  Orchestrators.OrchestratorMcpService,
  Effect.gen(function* () {
    const upstream = yield* Orchestrators.OrchestratorMcpService;
    // Standalone upstream toolkits can be used without a Hub state directory.
    const config = yield* Effect.serviceOption(ServerConfig);
    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);
    if (Option.isNone(config) || Option.isNone(fs) || Option.isNone(path)) return upstream;
    const context = Context.make(ServerConfig, config.value).pipe(
      Context.add(FileSystem.FileSystem, fs.value),
      Context.add(Path.Path, path.value),
    );
    return {
      ...upstream,
      listThreads: Effect.fn(function* (scope, input) {
        const page = yield* upstream.listThreads(scope, input);
        const markers = yield* Effect.gen(function* () {
          const all = yield* readDesignations;
          const { workspaces } = yield* Workspaces.list();
          const result = new Map<string, string>();
          for (const workspace of workspaces) {
            if (workspace.deleted || workspace.kind !== "enterprise" || !workspace.relay) continue;
            for (const [projectId, threadId] of Object.entries(all[workspace.id]?.projects ?? {}))
              result.set(projectId + "/" + threadId, workspace.relay.origin);
          }
          return result;
        }).pipe(
          Effect.provideContext(context),
          Effect.orElseSucceed(() => new Map<string, string>()),
        );
        return {
          ...page,
          threads: page.threads.map((thread) => {
            const origin = markers.get(thread.projectId + "/" + thread.threadId);
            return origin ? { ...thread, projectOrchestratorFor: origin } : thread;
          }),
        };
      }),
    } satisfies Orchestrators.OrchestratorMcpService["Service"];
  }),
).pipe(Layer.provide(Orchestrators.layer));
