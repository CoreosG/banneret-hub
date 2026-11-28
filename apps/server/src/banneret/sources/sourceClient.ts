// Banneret Hub: the Hub's own calls to a company source, for a person's button press and to read back what an
// agent claimed. They use the person's sign-in and the proxy's transport (no redirects), and never go
// through the relay. Each `open` is one MCP session. Nothing is kept.
// @effect-diagnostics nodeBuiltinImport:off - request ids.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { catalog, rpcResponse } from "../plugins/catalog.ts";
import { forward } from "../plugins/transport.ts";
import { missingTools } from "./filters.ts";
import type { CompanySource } from "./ownership.ts";
import { applyCredential, sourceAccess } from "./tokens.ts";

/**
 * `no_answer` is the only one after which a write may have happened. `tool` is the source's own refusal
 * of one call.
 */
export class SourceCallError extends Schema.TaggedError<SourceCallError>()("SourceCallError", {
  kind: Schema.Literals(["signed_out", "refused", "unreachable", "shape", "tool", "no_answer"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const SOURCE_TIMEOUTS = { exchangeMs: 15_000 };
const MAX_PAGES = 100;

/** A source's own words, kept to one short line. */
const oneLine = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : "";

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const notSignedIn = (source: CompanySource) =>
  source.auth === "none"
    ? `${source.title} did not accept this machine on your company network.`
    : `Sign in to ${source.title} on this machine, under Settings, Chat, Company servers.`;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isSourceCallError = Schema.is(SourceCallError);

export const openSource = Effect.fn("BanneretSources.open")(function* (
  relayOrigin: string,
  source: CompanySource,
) {
  const fail = (kind: SourceCallError["kind"], detail: string) =>
    new SourceCallError({ kind, detail });
  const unreachable = () => fail("unreachable", `${source.title} could not be reached.`);
  const noAnswer = () => fail("no_answer", `${source.title} did not answer.`);
  const access = yield* sourceAccess(relayOrigin, source).pipe(Effect.mapError(unreachable));
  if (access.state === "unreachable") return yield* unreachable();
  if (access.state !== "ready") return yield* fail("signed_out", notSignedIn(source));
  const token = access.token;
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });

  /** One request and its whole answer, inside one time limit. `id` is null for a notification. */
  const exchange = Effect.fn("BanneretSources.exchange")(
    function* <A>(
      method: string,
      params: object,
      id: string | null,
      read: (response: Response, id: string) => Promise<A>,
    ) {
      const body = encodeJson({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          forward(
            new Request(source.url, { method: "POST", headers }),
            source.url,
            token,
            signal,
            body,
          ),
        catch: noAnswer,
      });
      if (response.status === 401 || response.status === 403) {
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
          Effect.ignore,
        );
        // A 403 on one call refuses that call. On the handshake it refuses the person.
        if (response.status === 403 && method !== "initialize")
          return yield* fail("tool", `${source.title} refused this request.`);
        if (source.auth !== "none")
          yield* applyCredential(relayOrigin, source.id, {
            type: "rejected",
            token,
            as: response.status === 401 ? "expired" : "refused",
          }).pipe(Effect.ignore);
        return yield* fail(
          "refused",
          source.auth === "none"
            ? notSignedIn(source)
            : `${source.title} did not accept your sign-in. ${notSignedIn(source)}`,
        );
      }
      if (response.status >= 400) {
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
          Effect.ignore,
        );
        return yield* noAnswer();
      }
      const session = response.headers.get("mcp-session-id");
      if (session) headers.set("mcp-session-id", session);
      return yield* Effect.tryPromise({
        try: () => read(response, id ?? ""),
        catch: noAnswer,
      });
    },
    Effect.timeoutOrElse({
      duration: SOURCE_TIMEOUTS.exchangeMs,
      orElse: () => Effect.fail(noAnswer()),
    }),
  );

  /** Nothing has been written yet, so a silent source during the setup is only unreachable. */
  const setUp = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((error) =>
        isSourceCallError(error) && error.kind !== "no_answer" ? error : unreachable(),
      ),
    );

  const started = yield* setUp(
    exchange(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Banneret Hub", version: "1" },
      },
      NodeCrypto.randomUUID(),
      rpcResponse,
    ),
  );
  if (!record(started)?.result) return yield* unreachable();
  const version = record(record(started)?.result)?.protocolVersion;
  if (typeof version === "string") headers.set("mcp-protocol-version", version);
  yield* setUp(
    exchange("notifications/initialized", {}, null, async (response) => {
      await response.body?.cancel();
    }),
  );

  const listed = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = yield* setUp(
      exchange("tools/list", cursor ? { cursor } : {}, NodeCrypto.randomUUID(), catalog),
    );
    if (!read.tools) return yield* unreachable();
    for (const tool of read.tools) listed.add(tool.name);
    cursor = read.cursor;
    if (!cursor) break;
  }
  const missing = missingTools(source, listed);
  if (missing.length)
    return yield* fail(
      "shape",
      `${source.title} is unavailable. It does not offer ${missing.join(", ")}.`,
    );

  /** One tool call by its contract name, without the source's prefix. Returns `structuredContent`. */
  const call = Effect.fn("BanneretSources.call")(function* (name: string, args: object) {
    const answer = record(
      yield* exchange(
        "tools/call",
        { name: source.prefix + name, arguments: args },
        NodeCrypto.randomUUID(),
        rpcResponse,
      ),
    );
    const error = record(answer?.error);
    if (error)
      return yield* fail("tool", `${source.title} refused: ${oneLine(error.message) || name}`);
    const result = record(answer?.result);
    if (result?.isError === true) {
      const content: unknown = result.content;
      const said = oneLine(record(Array.isArray(content) ? content[0] : undefined)?.text);
      return yield* fail("tool", `${source.title} refused: ${said || name}`);
    }
    if (!record(result?.structuredContent)) return yield* noAnswer();
    return result!.structuredContent;
  });

  return { call };
});
export type SourceSession = Effect.Success<ReturnType<typeof openSource>>;
