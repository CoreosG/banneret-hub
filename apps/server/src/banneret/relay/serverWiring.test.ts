// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalTimers:off globalTimersInEffect:off - boots the real server in a child process and calls it over HTTP and WebSocket.
// Banneret Hub: the enrolment service reaches clients only through server.ts's layer wiring. The
// service is a Context.Reference whose default answers "not running", so a unit test cannot see a
// dropped provide line; this boots the real server and calls banneretRelay.probe over /ws. The feed
// is a reference too (its default answers "not joined"), so the second test joins a fake relay.
import { bootServer, stopServer } from "./serverFixture.ts";
import { expect, it } from "@effect/vitest";
import { startFakeRelay } from "@t3tools/banneret-relay-fake";
import {
  BANNERET_RELAY_FEED_WS_METHODS,
  BANNERET_RELAY_WS_METHODS,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const decodeToken = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }));
const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));

/** Exchanges the desktop bootstrap token for a session, then mints a WebSocket ticket. */
async function webSocketTicket(server: Awaited<ReturnType<typeof bootServer>>) {
  await server.ready;
  const tokenResponse = await fetch(`${server.origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: server.bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  const token = decodeToken(await tokenResponse.json());
  const ticketResponse = await fetch(`${server.origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
    },
  });
  return decodeTicket(await ticketResponse.json()).ticket;
}

it.live(
  "banneretRelay.probe through the real server answers the address rule, not 'not running'",
  () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => bootServer()),
        (booted) => Effect.promise(() => stopServer(booted)),
      );
      const ticket = yield* Effect.promise(() => webSocketTicket(server));
      const origin = server.origin;
      const protocol = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          Socket.layerWebSocket(
            `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
          ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        ),
        Layer.provide(RpcSerialization.layerJson),
      );
      const outcome = yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        return yield* client[BANNERET_RELAY_WS_METHODS.probe]({
          origin: "http://127.evil.example",
        }).pipe(Effect.flip);
      }).pipe(Effect.provide(protocol));
      expect(outcome).toMatchObject({
        _tag: "BanneretRelayError",
        message: "The relay must use https.",
      });
    }).pipe(Effect.scoped),
);

it.live(
  "banneretRelay.today through the real server reads the relay once the machine has joined",
  () =>
    Effect.gen(function* () {
      const fake = yield* Effect.acquireRelease(
        Effect.promise(() => startFakeRelay({ port: 0, retryAfterMs: 50 })),
        (relay) => Effect.promise(() => relay.close()),
      );
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => bootServer()),
        (booted) => Effect.promise(() => stopServer(booted)),
      );
      const ticket = yield* Effect.promise(() => webSocketTicket(server));
      const protocol = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          Socket.layerWebSocket(
            `${server.origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
          ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        ),
        Layer.provide(RpcSerialization.layerJson),
      );
      const today = yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        yield* client[BANNERET_RELAY_WS_METHODS.start]({
          origin: fake.url,
          label: "Wiring check",
          kind: "server",
        });
        // The fake approves at once; the server finishes setup on its own schedule.
        yield* client[BANNERET_RELAY_WS_METHODS.status]({}).pipe(
          Effect.repeat({
            until: (list) =>
              list.enrolments.some(
                (view) =>
                  view.relayOrigin === new URL(fake.url).origin && view.state === "configured",
              ),
            // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the server is a subprocess and /ws has no enrolment change stream; status is a local read.
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () => Effect.die(new Error("the machine never finished joining")),
          }),
        );
        return yield* client[BANNERET_RELAY_FEED_WS_METHODS.today]({
          relayOrigin: fake.url,
        });
      }).pipe(Effect.provide(protocol));
      expect(today.joined).toBe(true);
      expect(today.value?.needsYou.items).toEqual([]);
    }).pipe(Effect.scoped),
);
