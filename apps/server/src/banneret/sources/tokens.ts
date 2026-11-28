// @effect-diagnostics globalFetch:off - a person's token travels with redirects off, so it only reaches the address it was sent to.
// Banneret Hub: a person's sign-ins to company sources. They live in this machine's secret store and
// nowhere else. `sourceAccess` is the only way to read a token. The state table is in
// docs/banneret/agents.md, and `transitionCredential` is its only writer.
// @effect-diagnostics nodeBuiltinImport:off - hashes the relay and source for a secret-store filename.
import * as NodeCrypto from "node:crypto";

import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Secrets from "../../auth/ServerSecretStore.ts";
import { mayCarrySignIn } from "./addresses.ts";
import type { SavedSource } from "./ownership.ts";

/** `url` is the source address the sign-in was made for. The token goes to no other. */
const url = Schema.String;
const BearerSignIn = Schema.Struct({
  url,
  status: Schema.Literal("signed_in"),
  kind: Schema.Literal("bearer"),
  token: Schema.String,
});
const OAuthSignIn = Schema.Struct({
  url,
  status: Schema.Literal("signed_in"),
  kind: Schema.Literal("oauth"),
  /** The access token. */
  token: Schema.String,
  refreshToken: Schema.optionalKey(Schema.String),
  /** Epoch milliseconds. Absent when the server did not say. */
  expiresAt: Schema.optionalKey(Schema.Finite),
  authorizationServer: Schema.String,
  tokenEndpoint: Schema.String,
  authMethods: Schema.Array(Schema.String),
  clientId: Schema.String,
  clientSecret: Schema.optionalKey(Schema.String),
  clientAuthMethod: Schema.optionalKey(Schema.String),
  resource: Schema.optionalKey(Schema.String),
});
export type OAuthSignIn = typeof OAuthSignIn.Type;
const Closed = Schema.Struct({ url, status: Schema.Literals(["expired", "refused"]) });
const Credential = Schema.Union([BearerSignIn, OAuthSignIn, Closed]);
export type Credential = typeof Credential.Type;
export type SignedIn = Extract<Credential, { status: "signed_in" }>;

const CredentialJson = Schema.fromJsonString(Credential);
const decodeCredential = Schema.decodeEffect(CredentialJson);
const encodeCredential = Schema.encodeEffect(CredentialJson);

export type CredentialEvent =
  | { readonly type: "signed_in"; readonly credential: SignedIn }
  | { readonly type: "sign_in_refused"; readonly url: string }
  | { readonly type: "refreshed"; readonly token: string; readonly credential: SignedIn }
  | { readonly type: "rejected"; readonly token: string; readonly as: "expired" | "refused" }
  | { readonly type: "signed_out" };

/** Signed out is no record. */
export function transitionCredential(
  from: Credential | undefined,
  event: CredentialEvent,
): Credential | undefined {
  /** An answer about a token that has since been replaced changes nothing. */
  const current = (token: string) => from?.status === "signed_in" && from.token === token;
  switch (event.type) {
    case "signed_in":
      return event.credential;
    case "sign_in_refused":
      // A refused new attempt leaves a working sign-in for the same address alone.
      return from?.status === "signed_in" && from.url === event.url
        ? from
        : { url: event.url, status: "refused" };
    case "refreshed":
      return current(event.token) ? event.credential : from;
    case "rejected":
      return from && current(event.token) ? { url: from.url, status: event.as } : from;
    case "signed_out":
      return undefined;
  }
}

const listeners = new Set<() => void>();
/** Tells open sign-in views to read again. */
export const notifySignIns = () => {
  for (const listener of listeners) listener();
};
/** One item at once, then one after each change. */
export const signInChanges = Stream.callback<void>(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          Queue.offerUnsafe(queue, undefined);
        };
        listeners.add(listener);
        listener();
        return listener;
      }),
      (listener) => Effect.sync(() => listeners.delete(listener)),
    ),
  { bufferSize: 1, strategy: "sliding" },
);

export const signInKey = (relayOrigin: string, sourceId: string) =>
  "source-sign-in-" +
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([relayOrigin, sourceId]))
    .digest("hex");

const locks = new Map<string, Semaphore.Semaphore>();
/** Memory only: how many refreshes of a sign-in got no answer, so a request that waited behind one reuses it. */
const unanswered = new Map<string, number>();
/** Memory only: after a sign-in service stayed silent, when the Hub asks it again. */
const quietUntil = new Map<string, number>();
/** One change at a time for each sign-in: a rotating refresh token must be spent only once. */
const locked = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => {
  let lock = locks.get(key);
  if (!lock) locks.set(key, (lock = Semaphore.makeUnsafe(1)));
  return lock.withPermits(1)(effect);
};

const secretStore = Effect.serviceOption(Secrets.ServerSecretStore).pipe(
  Effect.flatMap(Option.match({ onNone: () => Secrets.make, onSome: Effect.succeed })),
);

/** A damaged record reads as signed out. Its content is never logged. */
const load = Effect.fn("BanneretTokens.load")(function* (key: string) {
  const bytes = yield* (yield* secretStore).get(key);
  if (Option.isNone(bytes)) return undefined;
  return yield* decodeCredential(new TextDecoder().decode(bytes.value)).pipe(
    Effect.catch(() =>
      Effect.logWarning("Could not read a saved company sign-in.").pipe(Effect.as(undefined)),
    ),
  );
});

export const readCredential = (relayOrigin: string, sourceId: string) =>
  load(signInKey(relayOrigin, sourceId));

/** Read, transition and write. The caller holds the key's lock. */
const step = Effect.fn("BanneretTokens.step")(function* (key: string, event: CredentialEvent) {
  const from = yield* load(key);
  const to = transitionCredential(from, event);
  // A sign-out also removes a record that cannot be read.
  if (to === from && event.type !== "signed_out") return to;
  const store = yield* secretStore;
  if (to) yield* store.set(key, new TextEncoder().encode(yield* encodeCredential(to)));
  else yield* store.remove(key);
  quietUntil.delete(key);
  notifySignIns();
  return to;
});

/** `wanted` is asked under the lock, so a sign-out that came first also wins. */
export const applyCredential = (
  relayOrigin: string,
  sourceId: string,
  event: CredentialEvent,
  wanted: () => boolean = () => true,
) => {
  const key = signInKey(relayOrigin, sourceId);
  return locked(
    key,
    Effect.uninterruptible(Effect.suspend(() => (wanted() ? step(key, event) : load(key)))),
  );
};

/** The fetch every sign-in request uses: checked address, no redirects, bounded. */
export const signInFetch =
  (relayOrigin: string, sourceUrl: string, timeoutMs: number, cancel?: AbortSignal) =>
  async (input: string | URL | Request, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!mayCarrySignIn(target, relayOrigin, sourceUrl))
      throw new Error("The Hub does not send sign-ins to this address.");
    const deadline = AbortSignal.timeout(timeoutMs);
    return fetch(input, {
      ...init,
      redirect: "error",
      signal: cancel ? AbortSignal.any([cancel, deadline]) : deadline,
    });
  };

/** Whether an authorization server's answer ends the grant. Anything else may work next time. */
export const grantRefused = (cause: unknown) =>
  cause instanceof OAuthError &&
  !(
    cause instanceof ServerError ||
    cause instanceof TemporarilyUnavailableError ||
    cause instanceof TooManyRequestsError
  );

type Tokens = Awaited<ReturnType<typeof refreshAuthorization>>;
type Grant = Omit<OAuthSignIn, "token" | "refreshToken" | "expiresAt">;

/** The record a token answer gives. */
export const withTokens = (grant: Grant, tokens: Tokens, now: number): OAuthSignIn => ({
  ...grant,
  token: tokens.access_token,
  ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
  ...(tokens.expires_in === undefined ? {} : { expiresAt: now + tokens.expires_in * 1000 }),
});

/** Refresh this long before the access token ends, so a call never leaves with a dying one. */
const REFRESH_EARLY_MS = 60_000;
/** Part of the thread's 10-second start limit: the source gets what is left (proxyGate.ts). */
const REFRESH_TIMEOUT = "5 seconds";
const QUIET_MS = 30_000;

export type Access =
  | { readonly state: "ready"; readonly token: string }
  | { readonly state: "signed_out" | "expired" | "refused" | "unreachable" };

type Target = Pick<SavedSource, "id" | "url" | "auth">;

/** What the record means for the source as the relay publishes it now. */
export const signInState = (
  credential: Credential | undefined,
  source: Pick<Target, "url" | "auth">,
  now: number,
) => {
  if (!credential || credential.url !== source.url) return "signed_out" as const;
  if (credential.status !== "signed_in") return credential.status;
  if ((credential.kind === "oauth") !== (source.auth === "oauth")) return "signed_out" as const;
  return credential.kind === "oauth" &&
    !credential.refreshToken &&
    credential.expiresAt !== undefined &&
    credential.expiresAt <= now
    ? ("expired" as const)
    : ("signed_in" as const);
};

const needsRefresh = (credential: SignedIn, now: number) =>
  credential.kind === "oauth" &&
  credential.expiresAt !== undefined &&
  credential.expiresAt - REFRESH_EARLY_MS <= now;

/** The grant stays. The old token serves while it lasts; after that there is nothing to send. */
const withoutAnswer = (credential: OAuthSignIn, now: number): Access =>
  credential.expiresAt !== undefined && credential.expiresAt <= now
    ? { state: "unreachable" }
    : { state: "ready", token: credential.token };

const isQuiet = (key: string, now: number) => (quietUntil.get(key) ?? 0) > now;

const refresh = Effect.fn("BanneretTokens.refresh")(function* (
  relayOrigin: string,
  source: Target,
  key: string,
  /** The unanswered count when the caller asked, before it waited for the lock. */
  seen: number,
) {
  const now = yield* Clock.currentTimeMillis;
  // Read again under the lock: another request may have refreshed, or the person signed out.
  const saved = yield* load(key);
  const state = signInState(saved, source, now);
  if (saved?.status !== "signed_in" || state !== "signed_in") {
    if (state === "expired" && saved?.status === "signed_in")
      yield* step(key, { type: "rejected", token: saved.token, as: "expired" });
    return { state: state === "signed_in" ? "signed_out" : state } satisfies Access;
  }
  const usable = { state: "ready", token: saved.token } satisfies Access;
  if (saved.kind !== "oauth" || !needsRefresh(saved, now) || !saved.refreshToken) return usable;
  if ((unanswered.get(key) ?? 0) !== seen || isQuiet(key, now)) return withoutAnswer(saved, now);
  const refreshToken = saved.refreshToken;
  const outcome = yield* Effect.tryPromise({
    try: (signal) =>
      refreshAuthorization(saved.authorizationServer, {
        metadata: {
          issuer: saved.authorizationServer,
          authorization_endpoint: saved.authorizationServer,
          response_types_supported: ["code"],
          token_endpoint: saved.tokenEndpoint,
          token_endpoint_auth_methods_supported: [...saved.authMethods],
        },
        clientInformation: {
          client_id: saved.clientId,
          ...(saved.clientSecret ? { client_secret: saved.clientSecret } : {}),
          ...(saved.clientAuthMethod ? { token_endpoint_auth_method: saved.clientAuthMethod } : {}),
        },
        refreshToken,
        ...(saved.resource ? { resource: new URL(saved.resource) } : {}),
        fetchFn: signInFetch(relayOrigin, source.url, 10_000, signal),
      }),
    catch: (cause) => ({ refused: grantRefused(cause) }),
  }).pipe(
    Effect.match({
      onSuccess: (tokens) => ({ tokens, refused: false, silent: false }),
      onFailure: ({ refused }) => ({ tokens: undefined, refused, silent: false }),
    }),
    Effect.timeoutOrElse({
      duration: REFRESH_TIMEOUT,
      orElse: () => Effect.succeed({ tokens: undefined, refused: false, silent: true }),
    }),
  );
  if (outcome.tokens) {
    const next = withTokens(saved, outcome.tokens, now);
    yield* step(key, { type: "refreshed", token: saved.token, credential: next });
    return { state: "ready", token: next.token } satisfies Access;
  }
  if (outcome.refused) {
    yield* step(key, { type: "rejected", token: saved.token, as: "expired" });
    return { state: "expired" } satisfies Access;
  }
  unanswered.set(key, seen + 1);
  const after = yield* Clock.currentTimeMillis;
  if (outcome.silent) quietUntil.set(key, after + QUIET_MS);
  return withoutAnswer(saved, after);
});

/** The token to send a source now, refreshed first when it is about to end. */
export const sourceAccess = Effect.fn("BanneretTokens.access")(function* (
  relayOrigin: string,
  source: Target,
) {
  if (source.auth === "none") return { state: "ready", token: "" } satisfies Access;
  if (!mayCarrySignIn(source.url, relayOrigin, source.url))
    return { state: "refused" } satisfies Access;
  const key = signInKey(relayOrigin, source.id);
  const seen = unanswered.get(key) ?? 0;
  const saved = yield* load(key);
  const now = yield* Clock.currentTimeMillis;
  const state = signInState(saved, source, now);
  if (state === "signed_out") return { state } satisfies Access;
  if (state === "signed_in" && saved?.status === "signed_in") {
    if (!needsRefresh(saved, now)) return { state: "ready", token: saved.token } satisfies Access;
    if (saved.kind === "oauth" && isQuiet(key, now)) return withoutAnswer(saved, now);
  }
  // Its own fiber: a caller that goes away must not lose a token the company has already rotated.
  const running = yield* Effect.forkDetach(locked(key, refresh(relayOrigin, source, key, seen)));
  return yield* Fiber.join(running);
});
