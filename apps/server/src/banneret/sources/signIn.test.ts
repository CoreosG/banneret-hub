// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalJsonInEffect:off - a local OAuth and MCP server stands in for a company.
// A person's sign-in to a company source: OAuth and pasted tokens, refresh, expiry, sign-out, and
// that a token stays in this machine's secret store.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { type SignInAction, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { McpServer } from "effect/ai";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";

import * as Secrets from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { approvalMachine } from "../plugins/approvals.ts";
import { sourceUrlAllowed, mayCarrySignIn } from "./addresses.ts";
import { sourceGate } from "./proxyGate.ts";
import { signInHandlers, signInRows } from "./signInHandlers.ts";
import { environmentId, inThread, makeHub, ORIGIN, startTurn, TOOLS } from "./company.testkit.ts";
import { sourcesFor } from "./ThreadSources.ts";
import {
  type Credential,
  readCredential,
  signInKey,
  sourceAccess,
  transitionCredential,
} from "./tokens.ts";

const hub = makeHub(McpServer.McpServer);

interface Seen {
  path: string;
  method: string | undefined;
  tool: string | undefined;
  authorization: string | undefined;
}

/**
 * A company that signs people in: protected-resource and authorization-server metadata, dynamic
 * registration, consent, rotating refresh tokens and an MCP endpoint that needs the token.
 */
const company = Effect.gen(function* () {
  const state = {
    seen: [] as Seen[],
    access: new Set<string>(),
    refresh: new Set<string>(),
    codes: new Map<string, { challenge: string; redirectUri: string }>(),
    redirects: [] as string[],
    authorizations: [] as URL[],
    /** Every secret this company or the Hub made up, to search for later. */
    secrets: [] as string[],
    grants: [] as string[],
    minted: 0,
    expiresIn: 3600,
    tokenDown: false,
    /** Takes a refresh and never answers it. */
    tokenSilent: false,
    /** Answers the MCP endpoint with this status, whatever the token. */
    forbid: undefined as "handshake" | "call" | undefined,
    base: "",
  };
  let askedInSilence = () => {};
  const silentRefresh = new Promise<void>((resolve) => (askedInSilence = resolve));
  const mint = () => {
    const n = ++state.minted;
    const access = `access-secret-${n}`;
    const refresh = `refresh-secret-${n}`;
    state.access.add(access);
    state.refresh.add(refresh);
    state.secrets.push(access, refresh);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: state.expiresIn,
    };
  };
  const server = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        const url = new URL(request.url!, state.base);
        const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
          response.writeHead(status, { "content-type": "application/json", ...headers });
          response.end(JSON.stringify(body));
        };
        const rpc = url.pathname === "/mcp" && text ? JSON.parse(text) : undefined;
        state.seen.push({
          path: url.pathname,
          method: rpc?.method,
          tool: rpc?.params?.name,
          authorization: request.headers.authorization,
        });
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
          return json(200, {
            resource: state.base + "/mcp",
            authorization_servers: [state.base],
            scopes_supported: ["tools", "memory.person"],
          });
        if (url.pathname === "/.well-known/oauth-authorization-server")
          return json(200, {
            issuer: state.base,
            authorization_endpoint: state.base + "/authorize",
            token_endpoint: state.base + "/token",
            registration_endpoint: state.base + "/register",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
            scopes_supported: ["tools", "memory.person", "offline_access"],
          });
        if (url.pathname === "/register") {
          const asked = JSON.parse(text);
          state.redirects = asked.redirect_uris;
          state.secrets.push("client-secret-1");
          return json(201, {
            ...asked,
            client_id: "client-1",
            client_secret: "client-secret-1",
            token_endpoint_auth_method: "client_secret_post",
          });
        }
        if (url.pathname === "/authorize") {
          state.authorizations.push(url);
          const redirectUri = url.searchParams.get("redirect_uri")!;
          if (!state.redirects.includes(redirectUri))
            return json(400, { error: "invalid_request" });
          const code = `code-${state.codes.size + 1}`;
          state.codes.set(code, {
            challenge: url.searchParams.get("code_challenge")!,
            redirectUri,
          });
          const back = new URL(redirectUri);
          back.searchParams.set("code", code);
          back.searchParams.set("state", url.searchParams.get("state")!);
          response.writeHead(302, { location: back.href });
          return response.end();
        }
        if (url.pathname === "/token") {
          const form = new URLSearchParams(text);
          const grant = form.get("grant_type")!;
          state.grants.push(grant);
          if (state.tokenSilent && grant === "refresh_token") return askedInSilence();
          if (state.tokenDown) {
            response.writeHead(503).end("down for maintenance");
            return;
          }
          if (form.get("client_secret") !== "client-secret-1")
            return json(401, { error: "invalid_client" });
          if (grant === "refresh_token") {
            if (!state.refresh.delete(form.get("refresh_token")!))
              return json(400, { error: "invalid_grant" });
            return json(200, mint());
          }
          const issued = state.codes.get(form.get("code")!);
          state.codes.delete(form.get("code")!);
          const verifier = form.get("code_verifier")!;
          state.secrets.push(verifier);
          if (
            !issued ||
            form.get("redirect_uri") !== issued.redirectUri ||
            NodeCrypto.createHash("sha256").update(verifier).digest("base64url") !==
              issued.challenge
          )
            return json(400, { error: "invalid_grant" });
          return json(200, mint());
        }
        const token = request.headers.authorization?.replace("Bearer ", "");
        if (!token || !state.access.has(token))
          return json(
            401,
            {},
            {
              "www-authenticate": `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp"`,
            },
          );
        if (
          (state.forbid === "handshake" && rpc.method === "initialize") ||
          (state.forbid === "call" && rpc.method === "tools/call")
        )
          return json(403, {});
        if (rpc.id === undefined) return response.writeHead(202).end();
        return json(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result:
            rpc.method === "tools/list"
              ? { tools: TOOLS }
              : rpc.method === "tools/call"
                ? { content: [{ type: "text", text: "company:" + rpc.params.name }] }
                : {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    serverInfo: { name: "acme" },
                  },
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
    (server) => Effect.sync(() => server.close()),
  );
  state.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const mcp = () => state.seen.filter((request) => request.path === "/mcp");
  return { state, url: state.base + "/mcp", mcp, silentRefresh };
});

type Company = Effect.Success<typeof company>;

const target = { relayOrigin: ORIGIN, sourceId: "acme-gw" };
const act = (action: SignInAction) => signInHandlers["plugins.signIn"]({ action });
const onlyRow = (threadId: ThreadId) => Effect.map(signInRows(threadId), (rows) => rows[0]!);

/** The person's browser: opens the sign-in page and returns where it sends them. */
const consent = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    return new URL(response.headers.get("location")!);
  });

/** Starts a sign-in and consents; returns the address the browser comes back to. */
const startAndConsent = Effect.fn("Test.consent")(function* (threadId: ThreadId) {
  yield* act({ kind: "start", ...target });
  return yield* consent((yield* onlyRow(threadId)).authorizationUrl!);
});

/** The browser comes back to this Hub's own callback address. */
const callback = Effect.fn("Test.callback")(function* (returned: URL) {
  const response = yield* (yield* HttpClient.HttpClient).get(returned.pathname + returned.search);
  return { status: response.status, text: yield* response.text };
});

const signIn = Effect.fn("Test.signIn")(function* (threadId: ThreadId) {
  expect((yield* callback(yield* startAndConsent(threadId))).status).toBe(200);
});

const oauthHub = Effect.fn("Test.oauthHub")(function* (threadId: ThreadId, acme: Company) {
  return yield* hub({ threadId, url: acme.url, auth: "oauth" });
});

/** Every file under `directory`, as raw bytes in one string each. */
const filesUnder = (directory: string) =>
  Effect.promise(async () => {
    const entries = await NodeFSP.readdir(directory, { recursive: true, withFileTypes: true });
    return Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const path = NodePath.join(entry.parentPath, entry.name);
          return { path, bytes: (await NodeFSP.readFile(path)).toString("latin1") };
        }),
    );
  });

/** Collects everything logged while `body` runs. */
const capturingLogs = <A, E, R>(lines: string[], body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make(({ message, cause }) => {
          lines.push(String(message) + " " + Cause.pretty(cause));
        }),
      ]),
    ),
  );

/** Records every request the Hub sends out. */
const outbound = Effect.acquireRelease(
  Effect.sync(() => {
    const original = globalThis.fetch;
    const sent: Array<{ url: string; text: string }> = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      sent.push({
        url: request.url,
        text: JSON.stringify([...request.headers]) + (await request.clone().text()),
      });
      return original(input, init);
    };
    return { sent, original };
  }),
  ({ original }) => Effect.sync(() => (globalThis.fetch = original)),
);

describe("signing in to a company source", () => {
  it.live("signs in once, and Claude, Codex and approved calls all use it", () => {
    const threadId = ThreadId.make("sign-in-once");
    const logs: string[] = [];
    return inThread(
      threadId,
      capturingLogs(
        logs,
        Effect.gen(function* () {
          const wire = yield* outbound;
          const acme = yield* company;
          const t = yield* oauthHub(threadId, acme);
          const issued = yield* t.issue;

          expect((yield* t.rpc("tools/list")).text).toContain("needs your person to sign in");
          expect(acme.state.seen).toEqual([]);
          expect(yield* onlyRow(threadId)).toMatchObject({
            state: "signed_out",
            auth: "oauth",
            company: "Acme",
            address: new URL(acme.url).host,
          });

          // An open view hears about the sign-in without asking again.
          const watching = yield* signInHandlers["plugins.signIns"]({ threadId }).pipe(
            Stream.takeUntil((rows) => rows[0]?.state === "signed_in"),
            Stream.runLast,
            Effect.forkChild,
          );
          const returned = yield* startAndConsent(threadId);
          const asked = acme.state.authorizations[0]!.searchParams;
          expect(asked.get("code_challenge_method")).toBe("S256");
          expect(asked.get("resource")).toBe(acme.url);
          // The person-only scope is never part of the token a thread uses.
          expect(asked.get("scope")).toBe("tools offline_access");
          expect(returned.pathname).toBe("/banneret/sources/oauth/callback");
          expect(returned.hostname).toBe("127.0.0.1");
          const landed = yield* callback(returned);
          expect(landed).toMatchObject({ status: 200 });
          expect(landed.text).toContain("Signed in to Acme gateway. You can close this tab.");
          yield* Fiber.join(watching);

          // The waiting turn stays closed; the next one connects.
          expect((yield* t.rpc("tools/list")).text).toContain("needs your person to sign in");
          startTurn("turn-2");
          // Both CLIs get the Hub's own address with the thread token, and nothing of the person's.
          const hubEntry = "http://localhost/banneret/plugins/co-acme-gw";
          const headers = { Authorization: "Bearer session" };
          expect(issued?.pluginClaude?.["co-acme-gw"]).toEqual({
            type: "http",
            url: hubEntry,
            headers,
          });
          expect(issued?.pluginCodex?.["mcp_servers.co-acme-gw"]).toEqual({
            url: hubEntry,
            http_headers: headers,
          });
          expect((yield* t.rpc("initialize")).json.result).toBeDefined();
          expect(yield* t.names).toContain("acme_tasks_claim");
          expect((yield* t.call("acme_skills_get")).text).toContain("company:acme_skills_get");

          // A held write goes out from the Hub server with the person's sign-in.
          const approvals = yield* approvalMachine(environmentId);
          const held = yield* t.call("acme_tasks_claim", { taskId: "A-1" }).pipe(Effect.forkChild);
          const card = yield* approvals.updates.pipe(
            Stream.mapEffect(() => approvals.list()),
            Stream.filter((rows) => rows.length > 0),
            Stream.runHead,
            Effect.flatMap(Effect.fromOption),
            Effect.map((rows) => rows[0]!),
          );
          yield* approvals.decide(card.id, "once", "Ada", "");
          expect((yield* Fiber.join(held)).text).toContain("company:acme_tasks_claim");
          expect(
            acme.mcp().find((request) => request.tool === "acme_tasks_claim")?.authorization,
          ).toBe("Bearer access-secret-1");
          // The company never sees the Hub's thread token.
          expect(JSON.stringify(acme.state.seen)).not.toContain("Bearer session");

          // Every secret is in the secret store and nowhere else.
          const config = yield* ServerConfig;
          const files = yield* filesUnder(config.baseDir);
          const store = files.filter((file) => file.path.startsWith(config.secretsDir));
          const rest = files.filter((file) => !file.path.startsWith(config.secretsDir));
          expect(rest.some((file) => file.path.endsWith("approvals.sqlite"))).toBe(true);
          expect(store.some((file) => file.bytes.includes("access-secret-1"))).toBe(true);
          expect(acme.state.secrets).toHaveLength(4);
          yield* Effect.logWarning("log capture works");
          expect(logs.join("\n")).toContain("log capture works");
          const shown = [
            ...rest.map((file) => file.bytes),
            logs.join("\n"),
            JSON.stringify(yield* signInRows(threadId)),
            JSON.stringify(yield* signInRows(undefined)),
            JSON.stringify(issued),
            JSON.stringify(yield* approvals.list(threadId)),
          ];
          for (const secret of acme.state.secrets)
            for (const text of shown) expect(text).not.toContain(secret);
          // On the wire, a secret goes to the company and nowhere else, the relay included.
          const carrying = wire.sent.filter((request) =>
            acme.state.secrets.some((secret) => request.text.includes(secret)),
          );
          expect(carrying.length).toBeGreaterThan(0);
          expect(carrying.every((request) => request.url.startsWith(acme.state.base + "/"))).toBe(
            true,
          );
        }),
      ),
    );
  });

  it.live("refreshes before a call, once for many requests, and keeps the new token", () => {
    const threadId = ThreadId.make("sign-in-refresh");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const acme = yield* company;
        const t = yield* oauthHub(threadId, acme);
        // Ends inside the minute the Hub refreshes ahead of.
        acme.state.expiresIn = 30;
        yield* signIn(threadId);
        acme.state.expiresIn = 3600;
        startTurn("turn-2");
        const before = acme.mcp().length;
        const replies = yield* Effect.all(
          Array.from({ length: 5 }, () => t.names),
          { concurrency: "unbounded" },
        );
        for (const names of replies) expect(names).toContain("acme_tasks_claim");
        // A refresh token works once: a second refresh would have lost the sign-in.
        expect(acme.state.grants).toEqual(["authorization_code", "refresh_token"]);
        expect(
          new Set(
            acme
              .mcp()
              .slice(before)
              .map((request) => request.authorization),
          ),
        ).toEqual(new Set(["Bearer access-secret-2"]));
        expect(yield* readCredential(ORIGIN, "acme-gw")).toMatchObject({
          token: "access-secret-2",
          refreshToken: "refresh-secret-2",
        });
      }),
    );
  });

  it.live("keeps the sign-in while the sign-in server is down", () => {
    const threadId = ThreadId.make("sign-in-server-down");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const acme = yield* company;
        const t = yield* oauthHub(threadId, acme);
        acme.state.expiresIn = 30;
        yield* signIn(threadId);
        acme.state.tokenDown = true;
        // The old token still has time, so it is used.
        startTurn("turn-2");
        expect(yield* t.names).toContain("acme_tasks_claim");
        expect(acme.mcp().at(-1)?.authorization).toBe("Bearer access-secret-1");

        // Once it has ended, nothing is sent, and certainly nothing without a token.
        acme.state.tokenDown = false;
        acme.state.expiresIn = 0;
        startTurn("turn-3");
        yield* t.names;
        acme.state.tokenDown = true;
        const contacted = acme.mcp().length;
        startTurn("turn-4");
        expect((yield* t.rpc("tools/list")).text).toContain("(unreachable)");
        expect(acme.mcp()).toHaveLength(contacted);
        expect((yield* onlyRow(threadId)).state).toBe("signed_in");

        acme.state.tokenDown = false;
        acme.state.expiresIn = 3600;
        startTurn("turn-5");
        expect(yield* t.names).toContain("acme_tasks_claim");
      }),
    );
  });

  it.live("moves a withdrawn token to sign-in needed, with no retry", () => {
    const threadId = ThreadId.make("sign-in-revoked");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const acme = yield* company;
        const t = yield* oauthHub(threadId, acme);
        yield* signIn(threadId);
        startTurn("turn-2");
        expect(yield* t.names).toContain("acme_tasks_claim");

        acme.state.access.clear();
        const contacted = acme.mcp().length;
        const grants = acme.state.grants.length;
        expect((yield* t.rpc("tools/list")).text).toContain("needs your person to sign in");
        expect(acme.mcp()).toHaveLength(contacted + 1);
        for (const turn of ["turn-2", "turn-3", "turn-4"]) {
          startTurn(turn);
          expect((yield* t.rpc("initialize")).text).toContain("needs your person to sign in");
          expect((yield* t.call("acme_tasks_read")).text).toContain("needs your person");
        }
        expect(acme.mcp()).toHaveLength(contacted + 1);
        expect(acme.state.grants).toHaveLength(grants);
        expect((yield* onlyRow(threadId)).state).toBe("expired");
        // The dead tokens are gone from the store.
        expect(yield* readCredential(ORIGIN, "acme-gw")).toEqual({
          url: acme.url,
          status: "expired",
        });

        yield* signIn(threadId);
        startTurn("turn-5");
        expect(yield* t.names).toContain("acme_tasks_claim");
      }),
    );
  });

  it.live("expires a sign-in whose refresh is refused, without calling the source", () => {
    const threadId = ThreadId.make("sign-in-refresh-refused");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const acme = yield* company;
        const t = yield* oauthHub(threadId, acme);
        acme.state.expiresIn = 30;
        yield* signIn(threadId);
        acme.state.refresh.clear();
        startTurn("turn-2");
        const contacted = acme.mcp().length;
        expect((yield* t.rpc("tools/list")).text).toContain("needs your person to sign in");
        expect(acme.mcp()).toHaveLength(contacted);
        expect((yield* onlyRow(threadId)).state).toBe("expired");
      }),
    );
  });

  it.live("signs out at once, and cancels a sign-in that is still waiting", () => {
    const threadId = ThreadId.make("sign-out");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const acme = yield* company;
        const t = yield* oauthHub(threadId, acme);
        yield* signIn(threadId);
        startTurn("turn-2");
        expect(yield* t.names).toContain("acme_tasks_claim");

        // In the same turn: nothing more reaches the company.
        yield* act({ kind: "sign_out", ...target });
        const contacted = acme.mcp().length;
        expect((yield* t.rpc("tools/list")).text).toContain("needs your person to sign in");
        expect(acme.mcp()).toHaveLength(contacted);
        expect((yield* onlyRow(threadId)).state).toBe("signed_out");
        const secrets = yield* filesUnder((yield* ServerConfig).secretsDir);
        expect(secrets.some((file) => file.path.includes(signInKey(ORIGIN, "acme-gw")))).toBe(
          false,
        );

        const returned = yield* startAndConsent(threadId);
        yield* act({ kind: "sign_out", ...target });
        const late = yield* callback(returned);
        expect(late.status).toBe(400);
        expect(late.text).toContain("no longer waiting");
        expect(yield* readCredential(ORIGIN, "acme-gw")).toBeUndefined();
      }),
    );
  });

  it.live("takes a pasted address once, and only this sign-in's", () => {
    const threadId = ThreadId.make("sign-in-paste");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const acme = yield* company;
        yield* oauthHub(threadId, acme);
        const finish = (url: string) =>
          act({ kind: "finish", callbackUrl: Redacted.make(url) }).pipe(
            Effect.flip,
            Effect.map((error) => ("detail" in error ? error.detail : "")),
          );
        const first = yield* startAndConsent(threadId);
        // A second start replaces the first.
        const returned = yield* startAndConsent(threadId);
        expect(yield* finish(first.href)).toContain("no longer waiting");
        const elsewhere = new URL(returned.href);
        elsewhere.hostname = "attacker.example";
        expect(yield* finish(elsewhere.href)).toContain("does not belong");
        expect(yield* finish(returned.href + "&iss=https://other.example")).toContain(
          "does not belong",
        );
        yield* act({ kind: "finish", callbackUrl: Redacted.make(returned.href) });
        expect((yield* onlyRow(threadId)).state).toBe("signed_in");
        expect(yield* finish(returned.href)).toContain("no longer waiting");

        // A refused new attempt leaves the working sign-in in place.
        const again = yield* startAndConsent(threadId);
        again.searchParams.delete("code");
        again.searchParams.set("error", "access_denied");
        expect(yield* finish(again.href)).toContain("refused this sign-in");
        expect((yield* onlyRow(threadId)).state).toBe("signed_in");

        // Without one, the refusal is what the person sees.
        yield* act({ kind: "sign_out", ...target });
        const refused = yield* startAndConsent(threadId);
        refused.searchParams.delete("code");
        refused.searchParams.set("error", "access_denied");
        const page = yield* callback(refused);
        expect(page.status).toBe(400);
        expect(yield* onlyRow(threadId)).toMatchObject({ state: "refused" });
        expect((yield* onlyRow(threadId)).authorizationUrl).toBeUndefined();
      }),
    );
  });

  it.live("saves a pasted token only when the source takes it, then serves both CLIs", () => {
    const threadId = ThreadId.make("sign-in-bearer");
    const logs: string[] = [];
    return inThread(
      threadId,
      capturingLogs(
        logs,
        Effect.gen(function* () {
          const acme = yield* company;
          acme.state.access.add("personal-secret");
          const t = yield* hub({ threadId, url: acme.url, auth: "bearer_per_person" });
          const save = (token: string) =>
            act({ kind: "token", ...target, token: Redacted.make(token) });
          const refusal = (token: string) =>
            save(token).pipe(
              Effect.flip,
              Effect.map((error) => ("detail" in error ? error.detail : "")),
            );
          expect(yield* refusal("two words")).toContain("without spaces");
          expect(yield* refusal("line\r\nX-Injected: 1")).toContain("without spaces");
          expect(acme.state.seen).toEqual([]);
          expect(yield* refusal("wrong-secret")).toBe("Acme gateway refused that token.");
          expect((yield* onlyRow(threadId)).state).toBe("refused");

          yield* save("  personal-secret\n");
          expect((yield* onlyRow(threadId)).state).toBe("signed_in");
          const issued = yield* t.issue;
          expect(JSON.stringify(issued)).not.toContain("personal-secret");
          startTurn("turn-2");
          expect(yield* t.names).toContain("acme_tasks_claim");
          expect(acme.mcp().at(-1)?.authorization).toBe("Bearer personal-secret");
          const config = yield* ServerConfig;
          for (const file of yield* filesUnder(config.baseDir)) {
            expect(file.bytes).not.toContain("wrong-secret");
            if (!file.path.startsWith(config.secretsDir))
              expect(file.bytes).not.toContain("personal-secret");
          }
          expect(logs.join("\n")).not.toMatch(/personal-secret|wrong-secret/);
        }),
      ),
    );
  });

  it.live("treats a 403 on the handshake as a refusal, and on one call as that call's", () => {
    const threadId = ThreadId.make("sign-in-forbidden");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const acme = yield* company;
        const t = yield* oauthHub(threadId, acme);
        yield* signIn(threadId);
        startTurn("turn-2");
        acme.state.forbid = "call";
        expect((yield* t.call("acme_skills_get")).text).toContain("refused this request");
        expect((yield* onlyRow(threadId)).state).toBe("signed_in");
        acme.state.forbid = "handshake";
        expect((yield* t.rpc("initialize")).text).toContain("needs your person to sign in");
        expect((yield* onlyRow(threadId)).state).toBe("refused");
      }),
    );
  });

  it.live("forgets a sign-in when the source moves or the machine leaves", () => {
    const threadId = ThreadId.make("sign-in-moved");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const acme = yield* company;
        const other = yield* company;
        const t = yield* oauthHub(threadId, acme);
        const owners = {
          tasks: { owner: "external", source: "acme-gw", title: "Acme", prefix: "acme_" },
        } as const;
        yield* signIn(threadId);
        startTurn("turn-2");
        yield* t.publish(owners, { ...t.source, url: other.url });
        expect(yield* readCredential(ORIGIN, "acme-gw")).toBeUndefined();
        expect((yield* t.rpc("tools/list")).text).toContain("needs your person to sign in");
        expect(other.state.seen).toEqual([]);

        yield* t.publish(owners);
        yield* signIn(threadId);
        // The same address again keeps the sign-in.
        yield* t.publish(owners);
        expect(yield* readCredential(ORIGIN, "acme-gw")).toMatchObject({ status: "signed_in" });
        yield* t.publish(null);
        expect(yield* readCredential(ORIGIN, "acme-gw")).toBeUndefined();
      }),
    );
  });

  it.live("sends no sign-in to the company relay's own address", () => {
    const threadId = ThreadId.make("sign-in-relay");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const wire = yield* outbound;
        const t = yield* hub({ threadId, url: ORIGIN + "/mcp", auth: "oauth" });
        for (const action of [
          { kind: "start", ...target },
          { kind: "token", ...target, token: Redacted.make("personal-secret") },
        ] as const)
          yield* act(action).pipe(Effect.flip);
        expect((yield* onlyRow(threadId)).state).toBe("refused");
        expect((yield* t.rpc("initialize")).text).toContain("needs your person to sign in");
        expect(wire.sent.filter((request) => request.url.startsWith(ORIGIN))).toEqual([]);
      }),
    );
  });

  // The record as this release writes it. A later release must still load it.
  it.live("loads a saved sign-in as written", () => {
    const threadId = ThreadId.make("sign-in-file");
    return inThread(
      threadId,
      Effect.gen(function* () {
        const store = yield* Secrets.make;
        const source = {
          id: "acme-gw",
          url: "https://mcp.example.test/gw",
          auth: "oauth" as const,
        };
        const write = (record: string) =>
          store.set(signInKey(ORIGIN, source.id), new TextEncoder().encode(record));
        yield* write(
          '{"url":"https://mcp.example.test/gw","status":"signed_in","kind":"oauth","token":"at","refreshToken":"rt","expiresAt":9999999999999,"authorizationServer":"https://id.example.test","tokenEndpoint":"https://id.example.test/token","authMethods":["none"],"clientId":"c1","clientAuthMethod":"none","resource":"https://mcp.example.test/gw"}',
        );
        expect(yield* sourceAccess(ORIGIN, source)).toEqual({ state: "ready", token: "at" });
        // A record for another address, or of the other kind, is no sign-in.
        for (const moved of [
          { ...source, url: "https://mcp.example.test/new" },
          { ...source, auth: "bearer_per_person" as const },
        ])
          expect(yield* sourceAccess(ORIGIN, moved)).toEqual({ state: "signed_out" });
        yield* write(
          '{"url":"https://mcp.example.test/gw","status":"signed_in","kind":"bearer","token":"bt"}',
        );
        expect(yield* sourceAccess(ORIGIN, { ...source, auth: "bearer_per_person" })).toEqual({
          state: "ready",
          token: "bt",
        });
        // A damaged record reads as signed out.
        yield* write("{");
        expect(yield* sourceAccess(ORIGIN, source)).toEqual({ state: "signed_out" });
      }),
    );
  });
});

describe("the 10-second connection limit", () => {
  it.effect.each(["initialize", "tools/list"] as const)(
    "gives up on a server that never answers %s",
    (method) => {
      const threadId = ThreadId.make("limit-" + method);
      return inThread(
        threadId,
        Effect.gen(function* () {
          let arrived: () => void;
          const request = new Promise<void>((resolve) => (arrived = resolve));
          // Takes the connection and says nothing.
          const silent = yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const server = NodeHttp.createServer(() => arrived());
              await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
              return server;
            }),
            (server) =>
              Effect.sync(() => {
                server.closeAllConnections();
                server.close();
              }),
          );
          const url = `http://127.0.0.1:${(silent.address() as { port: number }).port}/mcp`;
          yield* hub({ threadId, url });
          const [plugin] = yield* sourcesFor(ORIGIN);
          const gate = yield* sourceGate(plugin!, threadId);
          const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} });
          const web = new Request("http://hub.invalid/mcp", { method: "POST", body });
          const waiting = yield* (
            method === "initialize" ? gate.initialize(web, body) : gate.list(web)
          ).pipe(Effect.forkChild);
          yield* Effect.promise(() => request);
          yield* TestClock.adjust("9999 millis");
          expect(waiting.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 millis");
          expect((yield* Fiber.join(waiting)).message).toContain("(unreachable)");
        }),
      );
    },
  );
});

describe("a sign-in service that never answers", () => {
  // The Test Clock starts at zero, so a token given 30 seconds still works and one given none does not.
  it.effect.each([
    ["the old token still works", 30],
    ["the old token has ended", 0],
  ] as const)("holds a thread's start inside the limit when %s", ([, expiresIn]) => {
    const threadId = ThreadId.make("silent-" + expiresIn);
    return inThread(
      threadId,
      Effect.gen(function* () {
        const acme = yield* company;
        yield* oauthHub(threadId, acme);
        acme.state.expiresIn = expiresIn;
        const returned = yield* startAndConsent(threadId);
        yield* act({ kind: "finish", callbackUrl: Redacted.make(returned.href) });
        acme.state.tokenSilent = true;
        const [plugin] = yield* sourcesFor(ORIGIN);
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        const handshake = Effect.gen(function* () {
          const gate = yield* sourceGate(plugin!, threadId);
          const web = new Request("http://hub.invalid/mcp", { method: "POST", body });
          const reply = yield* gate.initialize(web, body);
          return reply.response ? "connected" : reply.message;
        });

        const waiting = yield* Effect.all([handshake, handshake, handshake], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Effect.promise(() => acme.silentRefresh);
        yield* TestClock.adjust("4999 millis");
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 millis");
        // All three finish with the clock standing still: none waited for a refresh of its own.
        const replies = [...(yield* Fiber.join(waiting)), yield* handshake];
        for (const reply of replies)
          if (expiresIn) expect(reply).toBe("connected");
          else expect(reply).toContain("(unreachable)");
        expect(acme.state.grants.filter((grant) => grant === "refresh_token")).toHaveLength(1);
        expect(yield* readCredential(ORIGIN, "acme-gw")).toMatchObject({ status: "signed_in" });
      }),
    );
  });
});

describe("sign-in state table", () => {
  const url = "https://mcp.example.test/gw";
  const live = (token: string): Credential => ({
    url,
    status: "signed_in",
    kind: "bearer",
    token,
  });
  const expired: Credential = { url, status: "expired" };
  const refused: Credential = { url, status: "refused" };
  type Event = Parameters<typeof transitionCredential>[1];
  const signedIn: Event = { type: "signed_in", credential: live("new") as never };
  const refreshed = (token: string): Event => ({
    type: "refreshed",
    token,
    credential: live("new") as never,
  });

  it.each<[Credential | undefined, Event, Credential | undefined]>([
    [undefined, signedIn, live("new")],
    [expired, signedIn, live("new")],
    [refused, signedIn, live("new")],
    [undefined, { type: "sign_in_refused", url }, refused],
    [expired, { type: "sign_in_refused", url }, refused],
    [live("a"), { type: "sign_in_refused", url }, live("a")],
    [live("a"), refreshed("a"), live("new")],
    // Answers about a replaced token, or after a sign-out, change nothing.
    [live("b"), refreshed("a"), live("b")],
    [undefined, refreshed("a"), undefined],
    [live("a"), { type: "rejected", token: "a", as: "expired" }, expired],
    [live("a"), { type: "rejected", token: "a", as: "refused" }, refused],
    [live("b"), { type: "rejected", token: "a", as: "expired" }, live("b")],
    [undefined, { type: "rejected", token: "a", as: "expired" }, undefined],
    [live("a"), { type: "signed_out" }, undefined],
    [expired, { type: "signed_out" }, undefined],
    [refused, { type: "signed_out" }, undefined],
  ])("%o then %o", (from, event, to) => {
    expect(transitionCredential(from, event)).toEqual(to);
  });

  it("sends a sign-in only over a safe address that is not the relay's", () => {
    const source = "https://mcp.example.test/gw";
    for (const target of ["https://id.example.test/token", "http://10.1.2.3/token"])
      expect(mayCarrySignIn(target, ORIGIN, source)).toBe(true);
    for (const target of [
      ORIGIN + "/token",
      "http://id.example.test/token",
      "http://127.0.0.1:9/token",
      "https://user:pass@id.example.test/token",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ])
      expect(mayCarrySignIn(target, ORIGIN, source)).toBe(false);
    expect(sourceUrlAllowed("http://127.0.0.1:9/mcp")).toBe(false);
  });
});
