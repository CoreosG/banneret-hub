import type { ListedTool, levelFor } from "./levels.ts";
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient, HttpServerResponse } from "effect/http";
import * as Schema from "effect/Schema";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";

const decodeCall = Schema.decodeUnknownOption(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Union([Schema.Finite, Schema.String]),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.String,
      arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  }),
);
const decodeCatalog = Schema.decodeUnknownOption(
  Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
        description: Schema.NonEmptyString,
      }),
    ),
  }),
);

export const skillReply = Effect.fn("SoloPlugins.skills")(function* (
  request: Request,
  plugin: { endpoint: string; token: string; manifest: { toolPrefix?: string | undefined } },
  thread: { threadId: ThreadId; providerInstanceId: ProviderInstanceId },
  permission: (
    tool: ListedTool,
  ) => Effect.Effect<
    string | undefined,
    Effect.Error<ReturnType<typeof levelFor>>,
    Effect.Services<ReturnType<typeof levelFor>>
  >,
) {
  const envelope = decodeCall(
    yield* Effect.promise(() =>
      request
        .clone()
        .json()
        .catch(() => null),
    ),
  );
  if (Option.isNone(envelope)) return;
  const { id, params } = envelope.value;
  const prefix = plugin.manifest.toolPrefix ?? "";
  const listing = params.name === prefix + "skills_list";
  if (!listing && params.name !== prefix + "skills_get") return;
  const shell = yield* (yield* ProjectionStoreV2).getThreadShell(thread.threadId);
  if (!shell) return;
  const project = yield* (yield* ProjectService).getShell(shell.projectId);
  if (Option.isNone(project)) return;
  const cwd = shell.worktreePath ?? project.value.workspaceRoot;
  const provider = (yield* (yield* ProviderRegistry).getProviders).find(
    (p) => p.instanceId === thread.providerInstanceId,
  );
  const defaults = (
    provider?.workspaceSnapshots?.find((s) => s.cwd === cwd)?.skills ??
    provider?.skills ??
    []
  ).filter((s) => s.enabled && !s.userInvocationOnly);
  if (!defaults.length) return;
  const requested = params.arguments?.name;
  const fallback = defaults.find((s) => s.name === requested);
  if (!listing && !fallback) return;
  const catalog = yield* Effect.gen(function* () {
    const client = yield* McpClient.McpClient;
    const list = (yield* client.listTools()).find((t) => t.name === prefix + "skills_list");
    if (!list || (yield* permission(list))) return;
    const result = yield* client.callTool({ tool: list, arguments: {} }, { timeout: "8 seconds" });
    const parsed = decodeCatalog(result.structuredContent);
    if (!result.isError && Option.isSome(parsed)) return parsed.value.skills;
  }).pipe(
    Effect.provide(
      McpClient.layerHttp({
        name: "banneret",
        version: "1",
        url: plugin.endpoint,
        headers: plugin.token ? { Authorization: "Bearer " + plugin.token } : {},
        protocol: McpProtocol.v2025_11_25,
        timeout: "8 seconds",
      }).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  );
  if (!catalog) return;
  const names = new Set(catalog.map((s) => s.name));
  if (!listing && (!fallback || names.has(fallback.name))) return;
  const skills = [...catalog];
  for (const skill of defaults) {
    if (names.has(skill.name)) continue;
    names.add(skill.name);
    skills.push({ name: skill.name, description: skill.description ?? skill.name });
  }
  const structuredContent =
    listing || !fallback
      ? { skills }
      : {
          name: fallback.name,
          description: fallback.description ?? fallback.name,
          text: yield* (yield* FileSystem.FileSystem).readFileString(fallback.path),
        };
  return HttpServerResponse.jsonUnsafe({
    jsonrpc: "2.0",
    id,
    result: { content: [], structuredContent },
  });
});
