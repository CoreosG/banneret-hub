// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - a stand-in Codex app-server and read-only settings files.
// A Hub chat's launch, with the person's own copy of a company server in their agent settings.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  CodexSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpServer } from "effect/ai";

import { ServerConfig } from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Infrastructure from "../../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import { McpSessionRegistry } from "../plugins/session.ts";
import { environmentId, inThread, makeHub } from "./company.testkit.ts";
import { claudeGuard } from "./ownCopyGuards.ts";
import { signInRows } from "./signInHandlers.ts";

const COMPANY = "https://mcp.acme.test/mcp";
const instance = ProviderInstanceId.make("codex");
const DEFAULTS = Schema.decodeSync(CodexSettings)({});
const MODEL = { instanceId: instance, model: "gpt-5.4" } satisfies ModelSelection;

/** The answer a real Codex gave to thread/start, from the recorded transcripts. */
const startedThread = () =>
  NodeFS.readFileSync(
    new URL(
      "../../orchestration-v2/testkit/fixtures/provider_thread_resume/codex_transcript.ndjson",
      import.meta.url,
    ),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { label?: string; frame?: { result?: unknown } })
    .find((entry) => entry.label === "thread/start" && entry.frame?.result)!.frame!.result;

/**
 * A stand-in Codex app-server. It answers config/read with what `own.json` holds at that moment (and
 * fails it when the file says null), and writes down each thread request it gets. Servers listed under
 * `projectFolder` come only with a config read for that folder, as a project's config.toml does.
 */
const fakeCodex = (directory: string) => {
  const binary = NodePath.join(directory, "codex");
  NodeFS.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = (name) => ${JSON.stringify(directory)} + "/" + name;
const started = ${JSON.stringify(startedThread())};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let reply = { result: {} };
  if (method === "initialize")
    reply.result = { userAgent: "codex/0.172.0", codexHome: path("home"), platformFamily: "unix", platformOs: "linux" };
  if (method === "config/read") {
    const own = JSON.parse(fs.readFileSync(path("own.json"), "utf8"));
    reply = own === null
      ? { error: { code: -32603, message: "config is broken" } }
      : {
          result: {
            config: {
              mcp_servers:
                own.projectFolder === undefined
                  ? own
                  : params.cwd === own.projectFolder ? own.servers : {},
            },
            origins: {},
          },
        };
  }
  if (method.startsWith("thread/")) {
    fs.appendFileSync(path("requests.ndjson"), JSON.stringify({ method, params }) + "\\n");
    reply.result = started;
  }
  process.stdout.write(JSON.stringify({ id, ...reply }) + "\\n");
});
`,
    { mode: 0o755 },
  );
  return {
    binary,
    own: (servers: object | null) =>
      NodeFS.writeFileSync(NodePath.join(directory, "own.json"), JSON.stringify(servers)),
    /** The params of every thread request of one kind, oldest first. */
    sent: (method: string): Array<Record<string, unknown>> => {
      const file = NodePath.join(directory, "requests.ndjson");
      if (!NodeFS.existsSync(file)) return [];
      return NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
        .filter((request) => request.method === method)
        .map((request) => request.params);
    },
    configs(method: string) {
      return this.sent(method).map((params) => params.config as Record<string, unknown>);
    },
  };
};

const mcpKeys = (config: Record<string, unknown>) =>
  Object.keys(config)
    .filter((key) => key === "mcp_servers" || /^mcp_servers\.(?!t3-code)/.test(key))
    .filter((key) => !key.endsWith(".env.T3CODE_THREAD_ID"))
    .sort();

/** The provider layers the server really runs, so the guard has to be wired into them. */
const providers = Infrastructure.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(PortScanner.layerTest),
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
);

/** A joined company thread whose MCP set the Hub issued, as every new agent session gets one. */
const companyThread = Effect.fn("Test.companyThread")(function* (threadId: ThreadId) {
  const hub = yield* makeHub(McpServer.McpServer)({ threadId, url: COMPANY });
  const issueConfig = Effect.flatMap(McpSessionRegistry, (registry) =>
    Effect.map(registry.issue({ threadId, providerInstanceId: instance }), (issued) => {
      return issued.config as McpProviderSessionConfig;
    }),
  );
  const ownCopy = Effect.map(signInRows(threadId), (rows) => rows[0]?.ownCopy);
  return { hub, issueConfig, ownCopy };
});

// Windows cannot run the stand-in script as a binary.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "a Codex launch in a company chat",
  () => {
    const threadId = ThreadId.make("own-copy-codex");

    const codexChat = Effect.fn("Test.codexChat")(function* () {
      const { issueConfig, ownCopy } = yield* companyThread(threadId);
      const codex = fakeCodex(
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "fake-codex-" }),
      );
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const config = yield* issueConfig;
      yield* sessions.set({ ...config, environmentId });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: instance,
        settings: { ...DEFAULTS, binaryPath: codex.binary },
        environment: { PATH: (yield* HostProcess.Environment).PATH },
        clientFactory: yield* CodexAdapterV2.CodexAppServerClientFactory,
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-own-copy"),
        modelSelection: MODEL,
        runtimePolicy,
      });
      const hubEntry = config.soloPlugins!.pluginCodex!["mcp_servers.co-acme-gw"];
      return {
        codex,
        hubEntry,
        issueConfig,
        ownCopy,
        start: runtime.ensureThread({ threadId, modelSelection: MODEL, runtimePolicy }),
        resume: (providerThread: Parameters<typeof runtime.resumeThread>[0]["providerThread"]) =>
          runtime.resumeThread({ providerThread, threadId, runtimePolicy }),
        resumeWithoutFolder: (
          providerThread: Parameters<typeof runtime.resumeThread>[0]["providerThread"],
        ) => runtime.resumeThread({ providerThread, threadId }),
      };
    });

    const run = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      inThread(
        threadId,
        body.pipe(Effect.provide(Layer.mergeAll(providers, McpProviderSessions.layer))),
      );

    it.live("switches the person's copies off for that session, on start and on resume", () =>
      run(
        Effect.gen(function* () {
          const chat = yield* codexChat();
          chat.codex.own({
            "acme-direct": { url: "https://MCP.acme.test:443/mcp/?team=1", enabled: true },
            bridge: { command: "npx", args: ["-y", "mcp-remote", COMPANY] },
            "acme-gw": { url: "https://mcp.acme.test/personal" },
            mine: { url: "https://mcp.example.test/mcp" },
          });

          const providerThread = yield* chat.start;
          yield* chat.resume(providerThread);

          const [started] = chat.codex.configs("thread/start");
          const [resumed] = chat.codex.configs("thread/resume");
          for (const config of [started!, resumed!]) {
            expect(mcpKeys(config)).toEqual([
              "mcp_servers.acme-direct.enabled",
              "mcp_servers.bridge.enabled",
              "mcp_servers.co-acme-gw",
            ]);
            expect(config["mcp_servers.acme-direct.enabled"]).toBe(false);
            expect(config["mcp_servers.bridge.enabled"]).toBe(false);
            expect(config["mcp_servers.co-acme-gw"]).toEqual(chat.hubEntry);
          }
          expect(yield* chat.ownCopy).toEqual({ settings: "Codex", off: true });
        }),
      ),
    );

    it.live("keeps their token and filters off the Hub's copy when they use its name", () =>
      run(
        Effect.gen(function* () {
          const chat = yield* codexChat();
          chat.codex.own({
            "co-acme-gw": { url: COMPANY, bearer_token_env_var: "MINE", enabled_tools: [] },
          });

          yield* chat.start;

          const [started] = chat.codex.configs("thread/start");
          expect(mcpKeys(started!)).toEqual([
            "mcp_servers.co-acme-gw-hub",
            "mcp_servers.co-acme-gw.enabled",
          ]);
          expect(started!["mcp_servers.co-acme-gw.enabled"]).toBe(false);
          expect(started!["mcp_servers.co-acme-gw-hub"]).toEqual(chat.hubEntry);
          expect(yield* chat.ownCopy).toEqual({ settings: "Codex", off: true });
        }),
      ),
    );

    it.live("reads again at each start, so a removed copy leaves no setting behind", () =>
      run(
        Effect.gen(function* () {
          const chat = yield* codexChat();
          chat.codex.own({ "acme-direct": { url: COMPANY } });
          yield* chat.start;
          expect(yield* chat.ownCopy).toEqual({ settings: "Codex", off: true });

          // Codex refuses a thread over a setting for a server it no longer has.
          chat.codex.own({});
          yield* chat.start;

          expect(mcpKeys(chat.codex.configs("thread/start")[1]!)).toEqual([
            "mcp_servers.co-acme-gw",
          ]);
          expect(yield* chat.ownCopy).toBeUndefined();
        }),
      ),
    );

    it.live("finds a project's copy when a resume names no folder", () =>
      run(
        Effect.gen(function* () {
          const chat = yield* codexChat();
          chat.codex.own({});
          const providerThread = yield* chat.start;
          // The folder Codex saved for the thread; only a config read for it shows the project's copy.
          const saved = (startedThread() as { thread: { cwd: string } }).thread.cwd;
          chat.codex.own({ projectFolder: saved, servers: { "in-project": { url: COMPANY } } });

          yield* chat.resumeWithoutFolder(providerThread);

          expect(chat.codex.sent("thread/resume")[0]).not.toHaveProperty("cwd");
          expect(chat.codex.sent("thread/read")).toEqual([
            { threadId: providerThread.nativeThreadRef!.nativeId, includeTurns: false },
          ]);
          const [resumed] = chat.codex.configs("thread/resume");
          expect(resumed!["mcp_servers.in-project.enabled"]).toBe(false);
        }),
      ),
    );

    it.live("does not start a company thread when Codex cannot say what it would load", () =>
      run(
        Effect.gen(function* () {
          const chat = yield* codexChat();
          chat.codex.own(null);

          yield* chat.start.pipe(Effect.flip);

          expect(chat.codex.configs("thread/start")).toEqual([]);
        }),
      ),
    );

    it.live("says a copy is still on when Codex cannot name it, until the next agent session", () =>
      run(
        Effect.gen(function* () {
          const chat = yield* codexChat();
          chat.codex.own({ "acme.direct": { url: COMPANY } });

          yield* chat.start;

          expect(mcpKeys(chat.codex.configs("thread/start")[0]!)).toEqual([
            "mcp_servers.co-acme-gw",
          ]);
          expect(yield* chat.ownCopy).toEqual({ settings: "Codex", off: false });
          // Another provider may be next, so nothing is claimed until it launches.
          yield* chat.issueConfig;
          expect(yield* chat.ownCopy).toBeUndefined();
        }),
      ),
    );
  },
);

/** Every file under a folder, with its bytes and write time. */
const snapshot = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { recursive: true, encoding: "utf8" })
    .sort()
    .map((name) => {
      const file = NodePath.join(directory, name);
      const stat = NodeFS.statSync(file);
      return `${name} ${stat.mtimeMs} ${stat.isFile() ? NodeFS.readFileSync(file, "utf8") : ""}`;
    });

const setMode = (directory: string, folder: number, file: number) => {
  NodeFS.chmodSync(directory, folder);
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) setMode(path, folder, file);
    else NodeFS.chmodSync(path, file);
  }
};

describe("a Claude launch in a company chat", () => {
  const threadId = ThreadId.make("own-copy-claude");
  const stdio = { command: "npx", args: ["mcp-remote", COMPANY, "--header", "Auth: mine"] };

  /** The person's settings as read-only files: a home or config folder, and a project. */
  const readOnlySettings = Effect.fn("Test.claudeSettings")(function* (configDir: boolean) {
    const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "own-claude-",
    });
    const home = NodePath.join(root, "home");
    const project = NodePath.join(root, "project");
    const cwd = NodePath.join(project, "packages", "app");
    NodeFS.mkdirSync(home, { recursive: true });
    NodeFS.mkdirSync(cwd, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { "acme-user": { type: "http", url: COMPANY + "/" }, mine: { command: "x" } },
        projects: { [cwd]: { mcpServers: { "acme-local": stdio } } },
      }),
    );
    NodeFS.writeFileSync(
      NodePath.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { "acme-shared": { type: "sse", url: COMPANY } } }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => setMode(root, 0o700, 0o600)));
    setMode(root, 0o500, 0o400);
    const env: Record<string, string> = configDir
      ? { HOME: project, CLAUDE_CONFIG_DIR: home }
      : { HOME: home };
    return { root, cwd, env };
  });

  /** Opens a query through the guard and returns the options the CLI would get. */
  const launch = Effect.fn("Test.claudeLaunch")(function* (
    config: McpProviderSessionConfig,
    options: { cwd: string; env: Record<string, string>; settings?: string | object },
  ) {
    const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
    const base = Layer.mock(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner)({
      open: (input) =>
        Effect.sync(() => {
          opened.push(input.options);
          return {} as ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
        }),
    });
    const { mcpServers } = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: config,
      readOnlySandbox: false,
    });
    yield* Effect.flatMap(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, (runner) =>
      runner.open({
        threadId,
        providerSessionId: ProviderSessionId.make("claude-own-copy"),
        options: {
          ...options,
          mcpServers,
        } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
      }),
    ).pipe(Effect.scoped, Effect.provide(claudeGuard.pipe(Layer.provide(base))));
    return opened[0]!;
  });

  it.live.each([{ configDir: false }, { configDir: true }])(
    "denies the person's copies and only reads their files (CLAUDE_CONFIG_DIR: $configDir)",
    ({ configDir }) =>
      inThread(
        threadId,
        Effect.gen(function* () {
          const { issueConfig, ownCopy } = yield* companyThread(threadId);
          const settings = yield* readOnlySettings(configDir);
          const before = snapshot(settings.root);

          const options = yield* launch(yield* issueConfig, {
            cwd: settings.cwd,
            env: settings.env,
            settings: { showThinkingSummaries: true },
          });

          expect(options.settings).toEqual({
            showThinkingSummaries: true,
            deniedMcpServers: [
              { serverUrl: COMPANY },
              { serverUrl: COMPANY + "/" },
              { serverName: "acme-user" },
              { serverName: "acme-local" },
              { serverName: "acme-shared" },
            ],
          });
          expect(yield* ownCopy).toEqual({ settings: "Claude", off: true });
          expect(snapshot(settings.root)).toEqual(before);
        }),
      ),
  );

  it.live("leaves a settings file path alone and says the copy is still on", () =>
    inThread(
      threadId,
      Effect.gen(function* () {
        const { issueConfig, ownCopy } = yield* companyThread(threadId);
        const settings = yield* readOnlySettings(false);

        const options = yield* launch(yield* issueConfig, {
          cwd: settings.cwd,
          env: settings.env,
          settings: "/somewhere/settings.json",
        });

        expect(options.settings).toBe("/somewhere/settings.json");
        expect(yield* ownCopy).toEqual({ settings: "Claude", off: false });
      }),
    ),
  );

  it.live("denies the company address even when it finds no copy, and shows no note", () =>
    inThread(
      threadId,
      Effect.gen(function* () {
        const { issueConfig, ownCopy } = yield* companyThread(threadId);
        const empty = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        NodeFS.writeFileSync(NodePath.join(empty, ".claude.json"), "{ not json");

        const options = yield* launch(yield* issueConfig, { cwd: empty, env: { HOME: empty } });

        expect(options.settings).toEqual({
          deniedMcpServers: [{ serverUrl: COMPANY }, { serverUrl: COMPANY + "/" }],
        });
        expect(yield* ownCopy).toBeUndefined();
      }),
    ),
  );
});
