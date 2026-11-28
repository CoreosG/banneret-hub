// Banneret Hub: signing a person in to a company source from their own machine. For `oauth` this is the
// MCP authorization flow with PKCE, ending on this Hub's own callback address. For `bearer_per_person`
// the person pastes a token and the Hub checks it with the source. Waiting sign-ins live in memory
// only. Neither path goes through the company relay (docs/banneret/agents.md).
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  registerClient,
  selectResourceURL,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { TaskLeaseError } from "@t3tools/contracts";
import { oauthCallbackUrl, pastedUrl } from "@t3tools/shared/oauthCallback";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../../config.ts";
import { mayCarrySignIn } from "./addresses.ts";
import { type CompanySource, companySources, readSavedOwnership } from "./ownership.ts";
import {
  applyCredential,
  grantRefused,
  notifySignIns,
  signInFetch,
  signInKey,
  withTokens,
} from "./tokens.ts";

const CALLBACK_PATH = "/banneret/sources/oauth/callback";
/** A thread's own token never asks for this: it is for the person's button presses (plugins.md). */
const PERSON_SCOPE = "memory.person";
const ATTEMPT_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 10_000;

type ServerInfo = Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
type Metadata = NonNullable<ServerInfo["authorizationServerMetadata"]>;
type Client = Awaited<ReturnType<typeof registerClient>>;

interface Attempt {
  readonly relayOrigin: string;
  readonly source: CompanySource;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly authorizationUrl: string;
  readonly expiresAt: number;
  readonly authorizationServer: string;
  readonly metadata: Metadata;
  readonly client: Client;
  readonly resource: URL | undefined;
  /** A callback uses an attempt once. */
  used: boolean;
}

/** One waiting sign-in per source. A new start replaces it; a restart drops it. */
const attempts = new Map<string, Attempt>();

/** The address of the sign-in page a source is waiting on, while the attempt lasts. */
export const waitingSignIn = (relayOrigin: string, sourceId: string, now: number) => {
  const attempt = attempts.get(signInKey(relayOrigin, sourceId));
  return attempt && !attempt.used && attempt.expiresAt > now ? attempt.authorizationUrl : undefined;
};

const failure = (detail: string) => new TaskLeaseError({ reason: "failed", detail });
const isTaskError = Schema.is(TaskLeaseError);
/** Library and server errors can carry response bodies, so only the Hub's own words go further. */
const attempted = <A>(run: () => Promise<A>, detail: string) =>
  Effect.tryPromise({ try: run, catch: () => failure(detail) });
const parsed = <A>(run: () => A, detail: string) =>
  Effect.try({ try: run, catch: () => failure(detail) });

const findSource = Effect.fn("BanneretSignIn.source")(function* (
  relayOrigin: string,
  sourceId: string,
  kind: "oauth" | "bearer_per_person",
) {
  const saved = yield* readSavedOwnership(relayOrigin);
  const source = saved && companySources(saved).find((s) => s.id === sourceId);
  if (!source || source.auth !== kind)
    return yield* failure("The company no longer asks for this sign-in. Reload and try again.");
  if (!mayCarrySignIn(source.url, relayOrigin, source.url))
    return yield* failure(
      "This server's address is the company relay's own. The Hub does not send your sign-in to the relay.",
    );
  return source;
});

const initializeRequest = (token?: string): RequestInit => ({
  method: "POST",
  headers: {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(token ? { authorization: "Bearer " + token } : {}),
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Banneret Hub", version: "1" },
    },
  }),
});

/** Asks the source without a token, for where it says to sign in. */
const challenge = async (fetchFn: typeof fetch, url: string) => {
  const response = await fetchFn(url, initializeRequest());
  await response.body?.cancel();
  return extractWWWAuthenticateParams(response);
};

const requestedScope = (
  named: string | undefined,
  supported: ReadonlyArray<string> | undefined,
  authorizationServerScopes: ReadonlyArray<string> | undefined,
) => {
  const scopes = (named?.split(" ") ?? [...(supported ?? [])]).filter(
    (scope) => scope && scope !== PERSON_SCOPE,
  );
  if (
    scopes.length &&
    !scopes.includes("offline_access") &&
    authorizationServerScopes?.includes("offline_access")
  )
    scopes.push("offline_access");
  return scopes.length ? scopes.join(" ") : undefined;
};

/** Starts an OAuth sign-in. The person opens the page `waitingSignIn` then names. */
export const startSignIn = Effect.fn("BanneretSignIn.start")(function* (
  relayOrigin: string,
  sourceId: string,
) {
  const source = yield* findSource(relayOrigin, sourceId, "oauth");
  const fetchFn = signInFetch(relayOrigin, source.url, STEP_TIMEOUT_MS);
  const unsupported = `${source.title} does not offer a sign-in the Hub can use. Tell your company's admin.`;

  const challenged = yield* attempted(
    () => challenge(fetchFn, source.url),
    `Could not reach ${source.title}.`,
  );
  const info = yield* attempted(
    () =>
      discoverOAuthServerInfo(source.url, {
        ...(challenged.resourceMetadataUrl
          ? { resourceMetadataUrl: challenged.resourceMetadataUrl }
          : {}),
        fetchFn,
      }),
    unsupported,
  );
  const metadata = info.authorizationServerMetadata;
  if (!metadata) return yield* failure(unsupported);
  if (!metadata.registration_endpoint)
    return yield* failure(
      `${source.title} only lets apps registered in advance sign in, and Banneret Hub does not support that yet. Tell your company's admin.`,
    );

  const { port } = yield* ServerConfig;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const scope = requestedScope(
    challenged.scope,
    info.resourceMetadata?.scopes_supported,
    metadata.scopes_supported,
  );
  const client = yield* Effect.tryPromise({
    try: () =>
      registerClient(info.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: "Banneret Hub",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        ...(scope ? { scope } : {}),
        fetchFn,
      }),
    catch: (cause) => ({ refused: grantRefused(cause) }),
  }).pipe(
    Effect.catch(({ refused }) =>
      refused
        ? applyCredential(relayOrigin, sourceId, {
            type: "sign_in_refused",
            url: source.url,
          }).pipe(Effect.andThen(failure(`${source.title} refused this sign-in.`)))
        : Effect.fail(failure(`Could not start the sign-in with ${source.title}.`)),
    ),
  );

  const random = yield* SecureRandom.SecureRandom;
  const state = Base64Url.encode(yield* random.randomBytes(32));
  const started = yield* attempted(async () => {
    const resource = await selectResourceURL(source.url, {} as never, info.resourceMetadata);
    const flow = await startAuthorization(info.authorizationServerUrl, {
      metadata,
      clientInformation: client,
      redirectUrl: redirectUri,
      state,
      ...(scope ? { scope } : {}),
      ...(resource ? { resource } : {}),
    });
    return { ...flow, resource };
  }, unsupported);
  const authorizationUrl = started.authorizationUrl.href;
  // The Hub shows this address as a link, and the code exchange sends the sign-in to the token address.
  if (
    [authorizationUrl, metadata.token_endpoint].some(
      (target) => !mayCarrySignIn(target, relayOrigin, source.url),
    )
  )
    return yield* failure(unsupported);
  attempts.set(signInKey(relayOrigin, sourceId), {
    relayOrigin,
    source,
    state,
    verifier: started.codeVerifier,
    redirectUri,
    authorizationUrl,
    expiresAt: (yield* Clock.currentTimeMillis) + ATTEMPT_MS,
    authorizationServer: info.authorizationServerUrl,
    metadata,
    client,
    resource: started.resource,
    used: false,
  });
  notifySignIns();
  // So an open view drops the link once it is dead.
  yield* Effect.sleep(ATTEMPT_MS).pipe(
    Effect.andThen(Effect.sync(notifySignIns)),
    Effect.forkDetach,
  );
  return { authorizationUrl };
});

const notWaiting = "This sign-in is no longer waiting. Start it again.";

/** Finishes a sign-in from the address the browser was sent back to. */
export const finishSignIn = Effect.fn("BanneretSignIn.finish")(function* (returned: string) {
  const asked = yield* parsed(() => pastedUrl(returned), "That is not a web address.");
  const state = asked.searchParams.get("state");
  const entry = [...attempts].find(([, attempt]) => attempt.state === state);
  const now = yield* Clock.currentTimeMillis;
  if (!entry || entry[1].used || entry[1].expiresAt <= now) return yield* failure(notWaiting);
  const [key, attempt] = entry;
  const { relayOrigin, source, metadata } = attempt;
  const foreign = "This address does not belong to the current sign-in.";
  const callback = yield* parsed(
    () => oauthCallbackUrl(returned, attempt.redirectUri, attempt.state),
    foreign,
  );
  // RFC 9207: an answer that names another sign-in server is not this one's.
  const issuer = callback.searchParams.get("iss");
  if (issuer !== null && issuer !== metadata.issuer) return yield* failure(foreign);
  attempt.used = true;
  notifySignIns();

  const current = () => attempts.get(key) === attempt;
  const end = Effect.sync(() => {
    if (current()) attempts.delete(key);
    notifySignIns();
  });
  const refused = applyCredential(
    relayOrigin,
    source.id,
    { type: "sign_in_refused", url: source.url },
    current,
  ).pipe(Effect.andThen(failure(`${source.title} refused this sign-in.`)));

  return yield* Effect.gen(function* () {
    const code = callback.searchParams.get("code");
    if (!code) return yield* refused;
    const tokens = yield* Effect.tryPromise({
      try: () =>
        exchangeAuthorization(attempt.authorizationServer, {
          metadata,
          clientInformation: attempt.client,
          authorizationCode: code,
          codeVerifier: attempt.verifier,
          redirectUri: attempt.redirectUri,
          ...(attempt.resource ? { resource: attempt.resource } : {}),
          fetchFn: signInFetch(relayOrigin, source.url, STEP_TIMEOUT_MS),
        }),
      catch: (cause) => ({ refused: grantRefused(cause) }),
    }).pipe(
      Effect.catch((error) =>
        error.refused
          ? refused
          : Effect.fail(failure(`Could not finish the sign-in with ${source.title}. Try again.`)),
      ),
    );
    // The company may have moved or dropped the source while the person was signing in.
    const published = yield* findSource(relayOrigin, source.id, "oauth");
    if (published.url !== source.url) return yield* failure(notWaiting);
    const credential = withTokens(
      {
        url: source.url,
        status: "signed_in",
        kind: "oauth",
        authorizationServer: attempt.authorizationServer,
        tokenEndpoint: metadata.token_endpoint,
        authMethods: metadata.token_endpoint_auth_methods_supported ?? [],
        clientId: attempt.client.client_id,
        ...(attempt.client.client_secret ? { clientSecret: attempt.client.client_secret } : {}),
        ...(attempt.client.token_endpoint_auth_method
          ? { clientAuthMethod: attempt.client.token_endpoint_auth_method }
          : {}),
        ...(attempt.resource ? { resource: attempt.resource.href } : {}),
      },
      tokens,
      yield* Clock.currentTimeMillis,
    );
    const saved = yield* applyCredential(
      relayOrigin,
      source.id,
      { type: "signed_in", credential },
      current,
    );
    // A sign-out or a newer start that got there first keeps this one out.
    if (saved !== credential) return yield* failure(notWaiting);
    return { title: source.title };
  }).pipe(Effect.ensuring(end));
});

/** Checks a pasted token with the source, then saves it. Nothing is saved unless the source takes it. */
export const saveSourceToken = Effect.fn("BanneretSignIn.token")(function* (
  relayOrigin: string,
  sourceId: string,
  token: string,
) {
  const source = yield* findSource(relayOrigin, sourceId, "bearer_per_person");
  if (!token || token.length > 8192 || !/^[\x21-\x7e]+$/.test(token))
    return yield* failure("Enter a token without spaces or line breaks.");
  const unchecked = `Could not check the token with ${source.title}. Nothing was saved.`;
  const fetchFn = signInFetch(relayOrigin, source.url, STEP_TIMEOUT_MS);
  const status = yield* attempted(async () => {
    const response = await fetchFn(source.url, initializeRequest(token));
    await response.body?.cancel();
    return response.status;
  }, unchecked);
  if (status === 401 || status === 403) {
    yield* applyCredential(relayOrigin, sourceId, { type: "sign_in_refused", url: source.url });
    return yield* failure(`${source.title} refused that token.`);
  }
  if (status < 200 || status >= 300) return yield* failure(unchecked);
  yield* applyCredential(relayOrigin, sourceId, {
    type: "signed_in",
    credential: { url: source.url, status: "signed_in", kind: "bearer", token },
  });
});

/** Removes this machine's sign-in and any sign-in still waiting. */
export const signOut = (relayOrigin: string, sourceId: string) =>
  Effect.suspend(() => {
    attempts.delete(signInKey(relayOrigin, sourceId));
    return applyCredential(relayOrigin, sourceId, { type: "signed_out" });
  });

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const page = (message: string, status = 200) =>
  HttpServerResponse.text(
    `<!doctype html><meta charset="utf-8"><title>Banneret Hub sign-in</title><body style="font:16px system-ui;margin:3rem 1rem;text-align:center"><p>${escapeHtml(message)}</p>`,
    {
      status,
      contentType: "text/html; charset=utf-8",
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    },
  );

/** Where the sign-in page sends a browser on this machine. The one-time `state` is what admits it. */
export const signInRoute = HttpRouter.add(
  "GET",
  CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { port } = yield* ServerConfig;
    const query = request.url.slice(request.url.indexOf("?") + 1);
    const done = yield* finishSignIn(`http://127.0.0.1:${port}${CALLBACK_PATH}?${query}`);
    return page(`Signed in to ${done.title}. You can close this tab.`);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(page(isTaskError(error) ? error.message : "The sign-in did not finish.", 400)),
    ),
  ),
);
