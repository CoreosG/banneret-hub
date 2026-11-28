// Banneret Hub: how the plugin proxy talks to a company source. It drives the per-thread state
// (ThreadSources.ts) from what the source answers, and bounds the calls a thread waits on at start.
import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { catalog } from "../plugins/catalog.ts";
import type { ListedTool } from "../plugins/levels.ts";
import { forward } from "../plugins/transport.ts";
import { readCapped } from "../relay/RelayClient.ts";
import { missingTools } from "./filters.ts";
import { makeSourceStates, sourceNotice, type ThreadSource } from "./ThreadSources.ts";
import { applyCredential, sourceAccess } from "./tokens.ts";

const states = makeSourceStates();
/**
 * A thread must not wait on a dead server: its connect and its tool list each get this long, a
 * sign-in refresh included.
 */
const STARTUP_MS = 10_000;
const MAX_PAGES = 100;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** Why an exchange broke. Every caller reports it as an unreachable source. */
const broke = (cause: unknown) => ({ cause });

export const sourceGate = Effect.fn("BanneretSources.gate")(function* (
  plugin: ThreadSource,
  threadId: ThreadId,
) {
  const run = (yield* (yield* ThreadManagementService).getThreadShell(threadId))?.activeRunId;
  const began = yield* Clock.currentTimeMillis;
  const access = yield* sourceAccess(plugin.relayOrigin, plugin.company);
  const startupLeft = Duration.millis(
    Math.max(0, STARTUP_MS - ((yield* Clock.currentTimeMillis) - began)),
  );
  // An unanswering sign-in server leaves the sign-in in place: the source is unreachable for now.
  const slot = states(
    threadId,
    plugin.company,
    run ?? null,
    access.state === "ready" || access.state === "unreachable",
  );
  if (access.state === "unreachable") slot.apply({ type: "unreachable" });
  const token = access.state === "ready" ? access.token : undefined;
  const { title, auth } = plugin.company;
  /** Why the source cannot be used right now; undefined while it can. */
  const closed = () =>
    sourceNotice(title, auth, slot.state()) ??
    (token === undefined ? `${title} could not be reached.` : undefined);
  const failed = (message = `${title} could not answer this request.`) => ({
    response: undefined,
    message: closed() ?? message,
  });
  const unreachable = () => {
    slot.apply({ type: "unreachable" });
    return failed(`${title} could not be reached.`);
  };
  /**
   * One exchange. A 401 or 403 never reaches the CLI: it would start its own sign-in against the Hub's
   * local address.
   */
  const send = Effect.fn("BanneretSources.send")(function* (
    request: Request,
    body?: string,
    handshake = false,
  ) {
    // Without a sign-in nothing is sent: never an anonymous request in the person's place.
    if (token === undefined) return failed(`${title} could not be reached.`);
    const response = yield* Effect.tryPromise({
      try: (signal) => forward(request, plugin.endpoint, token, signal, body),
      catch: broke,
    });
    if (response.status === 401 || response.status === 403) {
      yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore);
      // A 403 on the handshake refuses the person. On one call it refuses only that call.
      if (response.status === 403 && !handshake) return failed(`${title} refused this request.`);
      // No retry and no refresh: the person signs in again.
      slot.apply({ type: "unauthorized" });
      if (auth !== "none")
        yield* applyCredential(plugin.relayOrigin, plugin.company.id, {
          type: "rejected",
          token,
          as: response.status === 401 ? "expired" : "refused",
        });
      return failed();
    }
    return { response, message: undefined };
  }, Effect.orElseSucceed(unreachable));

  /** The MCP handshake, read whole inside the startup bound. */
  const initialize = Effect.fn("BanneretSources.initialize")(
    function* (request: Request, body: string) {
      const sent = yield* send(request, body, true);
      if (!sent.response) return sent;
      const { response } = sent;
      const bytes = yield* Effect.tryPromise({
        try: () => readCapped(response, 1024 * 1024),
        catch: broke,
      });
      if (response.status >= 400 || !bytes) return unreachable();
      return {
        response: new Response(new Uint8Array(bytes), {
          status: response.status,
          headers: response.headers,
        }),
        message: undefined,
      };
    },
    Effect.timeoutOrElse({ duration: startupLeft, orElse: () => Effect.sync(unreachable) }),
    Effect.orElseSucceed(unreachable),
  );

  const unlisted = (message?: string) => ({
    tools: undefined,
    message: message ?? unreachable().message,
  });

  /** Every page of the source's tool list as one, checked for the tools its owned capabilities need. */
  const list = Effect.fn("BanneretSources.list")(
    function* (request: Request) {
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      let result: object = {};
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const id = yield* (yield* SecureRandom.SecureRandom).uuidV4();
        const body = encodeJson({
          jsonrpc: "2.0",
          id,
          method: "tools/list",
          params: cursor ? { cursor } : {},
        });
        const sent = yield* send(request, body);
        if (!sent.response) return unlisted(sent.message);
        const { response } = sent;
        const read = yield* Effect.tryPromise({ try: () => catalog(response, id), catch: broke });
        if (!read.tools) return unlisted();
        const { nextCursor: _next, ...rest } = read.result;
        tools.push(...read.tools);
        result = rest;
        cursor = read.cursor;
        if (!cursor) break;
      }
      slot.apply({
        type: "listed",
        missing: missingTools(plugin.company, new Set(tools.map((tool) => tool.name))),
      });
      const notice = closed();
      return notice
        ? unlisted(notice)
        : { tools, result: { ...result, tools }, message: undefined };
    },
    Effect.timeoutOrElse({
      duration: startupLeft,
      orElse: () => Effect.sync(() => unlisted()),
    }),
    Effect.orElseSucceed(() => unlisted()),
  );

  return { closed, send, initialize, list };
});
