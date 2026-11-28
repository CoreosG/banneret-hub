import { memoryEnabled, isPluginMemoryTool } from "../memory/settings.ts";
import * as NodeSqlite from "node:sqlite";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { McpSchema, type McpServer } from "effect/ai";
import { forward, type StoredTransport } from "./transport.ts";
import { rpcResponse } from "./catalog.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { PreviewAgentActivity } from "../../preview/PreviewAgentActivity.ts";
import { workspacesFilePath } from "../Workspaces.ts";
import { approvalStore, type Approval, type Choice } from "./approvalStore.ts";
import { classify, levelFor, pluginSource, toolkitSource } from "./levels.ts";
import { threadWorkspace } from "./workspace.ts";
import { pluginsForThread } from "./session.ts";

const isApprovalError = Schema.is(McpSchema.InvalidParams);
const error = (message: string) => new McpSchema.InvalidParams({ message });
const resultError = (text: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text }] });
const replay = Context.Reference<string | undefined>("banneret/ApprovedReplay", {
  defaultValue: () => undefined,
});
const clientInfo = { name: "Banneret Hub", version: "1" };
const client = McpSchema.McpServerClient.of({
  clientId: 0,
  clientInfo,
  clientCapabilities: {},
  protocolVersion: "2025-06-18",
  initializePayload: { clientInfo, capabilities: {}, protocolVersion: "2025-06-18" },
  getClient: Effect.die("Approval replay does not accept client input."),
});
const json = Schema.fromJsonString(Schema.Unknown);
const encode = Schema.encodeEffect(json);
const decodeArgs = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeWire = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])) }),
  ),
);
const decodeToolResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);
const decode = Schema.decodeEffect(json);
interface CallContext {
  caller: McpInvocationScope;
  transport?: StoredTransport;
}
interface Machine {
  updates: Stream.Stream<number>;
  submit: (
    scope: McpInvocationScope,
    source: string,
    name: string,
    args: unknown,
    sensitive: boolean,
    transport?: StoredTransport,
  ) => Effect.Effect<McpSchema.CallToolResult, McpSchema.InvalidParams>;
  list: (threadId?: string) => Effect.Effect<Approval[], McpSchema.InvalidParams>;
  decide: (
    id: string,
    choice: Choice,
    actor: string,
    reason: string,
  ) => Effect.Effect<Approval, McpSchema.InvalidParams>;
}
const machines = new Map<string, Machine>();
export const approvalMachine = (id: EnvironmentId) =>
  Effect.fromNullishOr(machines.get(id)).pipe(
    Effect.mapError(() => error("The approval service is unavailable.")),
  );

type Registration = Parameters<McpServer.McpServer["Service"]["addTool"]>[0];
export function holdWrite(options: Registration): Registration["handle"] {
  const tool = options.tool;
  if (!tool.name.startsWith("banneret_") || classify(tool) === "read") return options.handle;
  return (args) =>
    Effect.gen(function* () {
      if ((yield* replay) === tool.name)
        return yield* options.handle(args).pipe(Effect.provideService(replay, undefined));
      const scope = Option.getOrUndefined(yield* Effect.serviceOption(McpInvocationContext));
      if (!scope?.thread) return yield* error("A Hub thread is required.");
      return yield* (yield* approvalMachine(scope.environmentId)).submit(
        scope,
        toolkitSource,
        tool.name,
        args,
        classify(tool) === "sensitive",
      );
    });
}

export const approvalLifecycle = (mcp: typeof McpServer.McpServer) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const machineScope = yield* Effect.scope;
      const env = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
      const threads = yield* ThreadManagementService;
      const activity = yield* PreviewAgentActivity;
      const server = yield* mcp;
      const path = yield* Path.Path;
      const dir = path.dirname(yield* workspacesFilePath);
      yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true });
      const file = path.join(dir, "approvals.sqlite");
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.scoped(fs.open(file, { flag: "a", mode: 0o600 }));
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(file)),
        (db) => Effect.sync(() => db.close()),
      );
      const store = approvalStore(db);
      const services =
        yield* Effect.context<
          Effect.Services<ReturnType<typeof pluginsForThread> | ReturnType<typeof levelFor>>
        >();
      const revision = yield* SubscriptionRef.make(0);
      const changed = SubscriptionRef.update(revision, (n) => n + 1);
      const waiting = new Map<string, Deferred.Deferred<McpSchema.CallToolResult>>();
      const wake = (id: string, result: McpSchema.CallToolResult) =>
        Effect.suspend(() => {
          const waiter = waiting.get(id);
          return waiter ? Deferred.succeed(waiter, result) : Effect.void;
        });
      const current = Effect.fn(function* (row: Approval) {
        const shell = yield* threads.getThreadShell(ThreadId.make(row.threadId));
        return shell?.activeRunId === row.turn && !shell.archivedAt && !shell.deletedAt;
      });
      const destination = Effect.fn(function* (id: ThreadId, endpoint?: string) {
        const shell = yield* threads.getThreadShell(id);
        if (!shell) return yield* error("Thread unavailable.");
        const owner = (yield* threadWorkspace(id, shell.projectId, env))?.owner;
        return yield* encode([
          shell.projectId,
          owner?.id ?? null,
          owner?.relay?.origin ?? null,
          endpoint ?? null,
        ]);
      }, Effect.provideContext(services));
      const execute = Effect.fn(
        function* (row: Approval) {
          const thread = ThreadId.make(row.threadId);
          const ctx = (yield* decode(row.context)) as CallContext;
          const args = yield* decodeArgs(row.args);
          const permitted = Effect.gen(function* () {
            if (!(yield* current(row)) || !(yield* activity.active(thread)))
              return yield* error("The original turn has ended.");
            if ((yield* levelFor(thread, row.source)) !== "read_write")
              return yield* error("This source no longer has write access.");
          });
          if ((yield* destination(thread, ctx.transport?.endpoint)) !== row.destination)
            return yield* error("The tool source changed.");
          yield* permitted;
          if (row.source === toolkitSource) {
            return yield* server.callTool({ name: row.name, arguments: args }).pipe(
              Effect.provideService(McpSchema.McpServerClient, client),
              Effect.provideService(McpInvocationContext, {
                ...ctx.caller,
                capabilities: new Set(ctx.caller.capabilities),
              }),
              Effect.provideService(replay, row.name),
            );
          }
          const records = yield* threads.getThreadRecords(thread, []);
          const plugin = (yield* pluginsForThread(records.thread, env)).find(
            (p) =>
              pluginSource(p.manifest.source) === row.source &&
              p.endpoint === ctx.transport?.endpoint,
          );
          if (!plugin) return yield* error("The original tool source is unavailable.");
          const transport = ctx.transport;
          if (!transport) return yield* error("The stored transport is unavailable.");
          const wire = yield* decodeWire(transport.body);
          yield* permitted;
          if (isPluginMemoryTool(row.name, plugin.manifest.toolPrefix) && !(yield* memoryEnabled))
            return yield* error("Banneret memory is off on this machine.");
          const response = yield* Effect.tryPromise({
            try: async (signal) =>
              rpcResponse(
                await forward(
                  new Request(plugin.endpoint, { method: "POST", headers: transport.headers }),
                  plugin.endpoint,
                  plugin.token,
                  signal,
                  transport.body,
                ),
                wire.id,
              ),
            catch: () => error("The plugin did not return a tool result."),
          });
          if (response.error) return resultError(String(response.error.message));
          return yield* decodeToolResult(response.result);
        },
        Effect.provideContext(services),
        Effect.match({
          onSuccess: (result) => result,
          onFailure: (e) => resultError(isApprovalError(e) ? e.message : "The stored call failed."),
        }),
      );
      const run = Effect.fn(function* (row: Approval) {
        const result = yield* execute(row);
        store.finish(row.id, result.isError ? "failed" : "ran");
        yield* changed;
        yield* wake(row.id, result);
        return result;
      });
      const expire = Effect.fn(function* (row: Approval) {
        if (row.state === "pending" && !(yield* current(row))) store.expire(row.id);
        const actual = store.get(row.id);
        if (actual.state === "expired")
          yield* wake(row.id, resultError("This call approval expired."));
        return actual;
      });
      const machine: Machine = {
        updates: SubscriptionRef.changes(revision),
        submit: Effect.fn(
          function* (scope, source, name, args, sensitive, transport) {
            if (!scope.thread) return yield* error("A Hub thread is required.");
            const thread = scope.thread.threadId;
            const shell = yield* threads.getThreadShell(thread);
            if (!shell?.activeRunId || !(yield* activity.active(thread)))
              return yield* error("The original turn has ended.");
            if ((yield* levelFor(thread, source)) !== "read_write")
              return yield* error("Write access is required.");
            const records = yield* threads.getThreadRecords(thread, ["runs"], {
              runIds: [shell.activeRunId],
            });
            const messageId = records.runs.find((r) => r.id === shell.activeRunId)?.userMessageId;
            const message = messageId
              ? (yield* threads.getMessagesById(thread, [messageId])).get(messageId)
              : undefined;
            const own =
              message?.createdBy === "user" &&
              !message.senderThreadId &&
              !message.linkedSender &&
              !shell.linkOrigin &&
              !shell.delegatedFrom;
            const row = store.hold({
              threadId: thread,
              threadTitle: shell.title,
              sensitive,
              destination: yield* destination(thread, transport?.endpoint),
              turn: shell.activeRunId,
              source,
              name,
              args: yield* encode(args ?? {}),
              context: yield* encode({
                caller: { ...scope, capabilities: [...scope.capabilities] },
                transport,
              }),
              allowAlways: !sensitive && own,
            });
            if (row.state === "refused") return resultError(row.reason);

            const waiter = Deferred.makeUnsafe<McpSchema.CallToolResult>();
            waiting.set(row.id, waiter);
            if (row.state === "running") yield* Effect.forkIn(run(row), machineScope);
            yield* changed;
            return yield* Deferred.await(waiter).pipe(
              Effect.ensuring(Effect.sync(() => waiting.delete(row.id))),
            );
          },
          Effect.provideContext(services),
          Effect.mapError((e) => error(e.message)),
        ),
        list: Effect.fn(
          function* (thread) {
            const rows = yield* Effect.forEach(store.list(thread), (row) =>
              row.state === "pending" ? expire(row) : Effect.succeed(row),
            );
            return thread ? rows : rows.filter((r) => r.state === "pending");
          },
          Effect.mapError((e) => error(e.message)),
        ),
        decide: Effect.fn(
          function* (id, choice, actor, reason) {
            yield* expire(
              yield* Effect.try({
                try: () => store.get(id),
                catch: () => error("Call approval not found."),
              }),
            );

            const { call: row, won } = yield* Effect.try({
              try: () => store.decide(id, choice, actor, reason),
              catch: (e) => error(String(e)),
            });
            if (!won) return row;
            yield* changed;
            if (row.state === "running") yield* Effect.forkIn(run(row), machineScope);
            if (row.state === "refused") yield* wake(id, resultError(row.reason));
            return store.get(id);
          },
          Effect.uninterruptible,
          Effect.mapError((e) => error(e.message)),
        ),
      };
      const turns = yield* activity.changes;
      yield* Effect.gen(function* () {
        const { active, threadId } = yield* PubSub.take(turns);
        if (active) return;
        for (const row of store.list(threadId)) {
          if (
            row.state !== "pending" ||
            ((yield* activity.active(threadId)) && (yield* current(row)))
          )
            continue;
          store.expire(row.id);
          yield* wake(row.id, resultError("The original turn has ended."));
        }
        yield* changed;
      }).pipe(Effect.forever, Effect.forkScoped);
      // A single timer follows the oldest pending row, including rows recovered at startup.
      yield* machine.updates.pipe(
        Stream.switchMap(() =>
          Stream.fromEffect(
            Effect.gen(function* () {
              for (const id of waiting.keys()) {
                if (store.get(id).state === "expired")
                  yield* wake(id, resultError("This call approval expired."));
              }
              const first = store.list()[0];
              if (!first) return yield* Effect.never;
              yield* Effect.sleep(
                Math.max(0, first.created + 86400000 - (yield* Clock.currentTimeMillis)),
              );
              yield* changed;
            }),
          ),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      machines.set(env, machine);
      yield* Effect.addFinalizer(() => Effect.sync(() => machines.delete(env)));
    }),
  ).pipe(Layer.provide(mcp.layer));
