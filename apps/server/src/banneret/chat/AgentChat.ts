// @effect-diagnostics nodeBuiltinImport:off - stable synchronous SHA-256 identifiers shared with delivery receipt validation.
import * as NodeCrypto from "node:crypto";
import {
  ChatConversations,
  ChatHandles,
  ChatAsks,
  ChatSettings,
  ChatDeliveries,
  ChatThread,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RelayEnrolment } from "../relay/Enrolment.ts";

export const handleId = (thread: string) =>
  "h_" + NodeCrypto.createHash("sha256").update(thread).digest("hex").slice(0, 40);
export const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const decodeConversations = Schema.decodeUnknownEffect(ChatConversations);
const decodeId = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
const decodeInbox = Schema.decodeUnknownEffect(ChatDeliveries);
const decodeThread = Schema.decodeUnknownEffect(ChatThread);
export function chatClient(
  relay: Pick<RelayEnrolment, "signedChat">,
  thread: string,
  provider: string,
  machineId: string,
) {
  const asHandle = handleId(thread);
  const request = (
    method: Parameters<RelayEnrolment["signedChat"]>[0],
    path: string,
    body?: unknown,
    /** The owner of the agent being asked, to name in a refusal. */
    askedOwner?: string,
  ) =>
    relay.signedChat(method, path, body).pipe(
      Effect.map((r) => r.body),
      Effect.mapError((e) =>
        invalid(
          e.code === "agent_ask_no_home"
            ? "Ask your owner to add you both to a channel."
            : e.code === "agent_ask_off" && askedOwner
              ? askedOwner + " doesn't take asks from other people's agents."
              : e.code === "review_same_owner" && path === "asks"
                ? "Choose another person’s reviewer. This agent’s owner wrote the pull request or holds the task lease."
                : e.message,
        ),
      ),
    );
  const read = (path: string, params: Record<string, string> = {}) =>
    request("GET", path + "?" + new URLSearchParams({ ...params, asHandle }));
  const root = (id: string) =>
    read("threads/" + id, { limit: "1" }).pipe(
      Effect.flatMap(decodeThread),
      Effect.mapError(() => invalid("Cannot read this thread.")),
      Effect.map((r) => r.root),
    );
  return {
    review: Effect.fn(function* (id: string) {
      let cursor: string | null = null;
      do {
        const page: ChatAsks = yield* request(
          "GET",
          "asks?role=answerer&state=open&limit=100" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ChatAsks)),
          Effect.mapError(() => invalid("Cannot read the review request.")),
        );
        const ask = page.items.find((a) => a.id === id && a.kind === "review");
        if (ask) return ask;
        cursor = page.nextCursor;
      } while (cursor);
      return yield* invalid("This review is closed.");
    }),
    checkDmHome: Effect.fn(function* (home: string, ownerText: string) {
      const message = yield* root(home);
      let cursor: string | null = null;
      do {
        const page: ChatConversations = yield* read("conversations", {
          limit: "100",
          ...(cursor ? { cursor } : {}),
        }).pipe(
          Effect.flatMap(decodeConversations),
          Effect.mapError(() => invalid("Cannot read the home conversation.")),
        );
        const channel = page.items.find((c) => c.id === message.conversationId);
        if (channel) {
          if (
            channel.kind === "channel" &&
            !ownerText.match(/#[a-z0-9_-]+/gi)?.includes("#" + channel.name)
          )
            return yield* invalid("Your owner's DM must name this channel before you ask there.");
          return;
        }
        cursor = page.nextCursor;
      } while (cursor);
      return yield* invalid("Ask your owner to add you both to a channel.");
    }),
    policy: request("GET", "me/settings").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ChatSettings)),
      Effect.map((s) => s.agentAsks),
      Effect.mapError(() => invalid("Cannot read the owner’s ask policy.")),
    ),
    resolveHandle: Effect.fn(function* (to: string) {
      let cursor: string | null = null;
      do {
        const page: ChatHandles = yield* request(
          "GET",
          "handles?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ChatHandles)),
          Effect.mapError(() => invalid("Cannot read agent handles.")),
        );
        const handle = page.items.find(
          (h) => h.id === to || h.owner.login + "/" + (h.shortName ?? h.claimName) === to,
        );
        if (handle) return handle;
        cursor = page.nextCursor;
      } while (cursor);
      return yield* invalid("Unknown agent. Ask your owner to add you both to a channel.");
    }),
    ensure: request("PUT", "handles/" + asHandle, { threadRef: thread, provider, machineId }),
    consumeInbox: request("POST", "inbox", { asHandle }).pipe(
      Effect.flatMap((body) =>
        decodeInbox(body).pipe(Effect.mapError(() => invalid("Invalid inbox response."))),
      ),
    ),
    read,
    root,
    asHandle,
    write: (
      method: "PUT" | "POST",
      path: string,
      body: object,
      handle = asHandle,
      askedOwner?: string,
    ) =>
      request(method, path, { ...body, asHandle: handle }, askedOwner).pipe(
        Effect.flatMap((value) =>
          decodeId(value).pipe(
            Effect.mapError(() => invalid("The relay returned no id for this message.")),
          ),
        ),
      ),
  };
}
