// Banneret Hub: puts ownCopies.ts in front of the two places a Hub chat starts its agent, Codex's
// app-server requests and Claude's query. It wraps the services themselves, so no adapter changes.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  hasCompanyEntry,
  recordLaunch,
  switchOffInClaude,
  switchOffInCodex,
  type OwnServer,
} from "./ownCopies.ts";

type CodexAppServer = CodexClient.CodexAppServerClient["Service"];

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};

interface CodexLaunch {
  /** The thread being resumed or forked. A start has none. */
  readonly threadId?: string;
  readonly cwd?: string | null;
  readonly config?: Readonly<Record<string, Schema.Json>> | null;
}

/**
 * Every Codex thread start, resume and fork. Codex's own config read says what the person has for that
 * folder, so the Hub never opens Codex's files. A read that fails also fails the launch: a company chat
 * must not start with a copy that was never looked for.
 */
const guardCodexClient = (client: CodexAppServer): CodexAppServer => {
  /** A resume can name no folder. Codex then loads the servers of the thread's own saved folder. */
  const savedFolder = (threadId: string) =>
    client.raw.request("thread/read", { threadId, includeTurns: false }).pipe(
      Effect.map((read) => {
        const { cwd } = record(record(read).thread);
        return typeof cwd === "string" ? cwd : undefined;
      }),
    );
  const launch = <A, E>(params: unknown, send: (params: never) => Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      const { threadId, cwd, config } = params as CodexLaunch;
      const company = hasCompanyEntry(config);
      if (!config || !company) return send(params as never);
      return Effect.gen(function* () {
        const folder = cwd || (threadId ? yield* savedFolder(threadId) : undefined);
        const read = yield* client.request("config/read", {
          ...(folder === undefined ? {} : { cwd: folder }),
          includeLayers: false,
        });
        const plan = switchOffInCodex(config, read.config.mcp_servers);
        const response = yield* send({ ...(params as object), config: plan.config } as never);
        recordLaunch(company.threadId, "Codex", plan.copies);
        return response;
      });
    });
  return {
    ...client,
    request: ((method, payload) =>
      method === "thread/start" || method === "thread/fork"
        ? launch(payload, (params) => client.request(method, params))
        : client.request(method, payload)) as CodexAppServer["request"],
    raw: {
      ...client.raw,
      // The adapter resumes through the raw request.
      request: ((method, payload) =>
        method === "thread/resume"
          ? launch(payload, (params) => client.raw.request(method, params))
          : client.raw.request(method, payload)) as CodexAppServer["raw"]["request"],
    },
  };
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * The MCP servers in the person's Claude settings for one folder: their own and per-project ones in
 * `.claude.json`, and each `.mcp.json` from the folder up. Read only. A file that cannot be read or
 * parsed counts as empty, and its content is never logged.
 */
const readClaudeServers = Effect.fn("BanneretOwnCopies.readClaudeServers")(function* (
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  cwd: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = environment.CLAUDE_CONFIG_DIR?.trim();
  const home = environment.HOME || (yield* HostProcess.HomeDirectory);
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.flatMap(decodeJson),
      Effect.map(record),
      Effect.orElseSucceed(() => record(undefined)),
    );
  const folders: string[] = [];
  for (let folder = cwd; folder;) {
    folders.push(folder);
    const parent = path.dirname(folder);
    folder = parent === folder ? undefined : parent;
  }
  const user = yield* read(path.join(configDir || home, ".claude.json"));
  const shared = yield* Effect.forEach(folders, (folder) => read(path.join(folder, ".mcp.json")));
  return [
    user,
    ...folders.map((folder) => record(record(user.projects)[folder])),
    ...shared,
  ].flatMap((file): ReadonlyArray<OwnServer> => Object.entries(record(file.mcpServers)));
});

/** Exported for its test, which puts a stand-in runner under it. */
export const claudeGuard = Layer.effect(
  ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
  Effect.gen(function* () {
    const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
    const hostEnvironment = yield* HostProcess.Environment;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const open = Effect.fn("BanneretOwnCopies.openClaude")(function* (
      input: Parameters<typeof runner.open>[0],
    ) {
      const { options } = input;
      if (!hasCompanyEntry(options.mcpServers)) return yield* runner.open(input);
      const own = yield* readClaudeServers(options.env ?? hostEnvironment, options.cwd).pipe(
        Effect.provideContext(services),
      );
      const plan = switchOffInClaude(options, own);
      const session = yield* runner.open({
        ...input,
        options: {
          ...options,
          ...(plan.settings === undefined
            ? {}
            : { settings: plan.settings as NonNullable<typeof options.settings> }),
        },
      });
      recordLaunch(input.threadId, "Claude", plan.copies);
      return session;
    });
    return { ...runner, open };
  }),
);

const codexGuard = Layer.effect(
  CodexAdapterV2.CodexAppServerClientFactory,
  Effect.gen(function* () {
    const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
    const open = Effect.fn("BanneretOwnCopies.openCodex")(function* (
      input: Parameters<typeof factory.open>[0],
    ) {
      return guardCodexClient(yield* factory.open(input));
    });
    return { open };
  }),
);

/**
 * The two services, guarded. Merge it after the layers it wraps: in `Layer.mergeAll` the later one
 * provides a service. Layers are shared by reference, so each base service is still built once.
 */
export const layer = Layer.merge(
  claudeGuard.pipe(Layer.provide(ClaudeAdapterV2.layerQueryRunner)),
  codexGuard.pipe(Layer.provide(CodexAdapterV2.layerAppServerClientFactory)),
);
