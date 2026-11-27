// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalTimers:off globalTimersInEffect:off - boots the real server in a child process and calls it over HTTP and WebSocket.
// Banneret Hub: the enrolment service reaches clients only through server.ts's layer wiring. The
// service is a Context.Reference whose default answers "not running", so a unit test cannot see a
// dropped provide line; this boots the real server and calls banneretRelay.probe over /ws. The feed
// is a reference too (its default answers "not joined"), so the second test joins a fake relay.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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

const BIN = NodeURL.fileURLToPath(new URL("../../bin.ts", import.meta.url));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const reservation = NodeHttp.createServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      reservation.close(() => resolve(port));
    });
  });

const decodeToken = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }));
const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));

/** Boots `bin.ts start` on a fresh home and a free loopback port, as the desktop app does. */
async function bootServer() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bh-wiring-"));
  const port = await freePort();
  const bootstrap = NodeCrypto.randomUUID();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [BIN, "start", "--bootstrap-fd", "3", "--log-level", "debug"],
    {
      env: { ...process.env, T3CODE_HOME: home, T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  const bootstrapPipe = child.stdio[3];
  if (bootstrapPipe === null || bootstrapPipe === undefined || !("write" in bootstrapPipe)) {
    throw new Error("no bootstrap pipe");
  }
  bootstrapPipe.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home: home,
      host: "127.0.0.1",
      desktopBootstrapToken: bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    for (const pipe of [child.stdout, child.stderr]) {
      pipe?.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(-16_384);
        if (output.includes("startup phase: complete")) resolve();
      });
    }
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited ${code}:\n${output}`)));
  });
  return { child, home, origin: `http://127.0.0.1:${port}`, bootstrap, ready };
}

async function stopServer(server: Awaited<ReturnType<typeof bootServer>>) {
  if (server.child.exitCode === null) {
    const exited = new Promise((resolve) => server.child.once("exit", resolve));
    server.child.kill("SIGTERM");
    const timer = setTimeout(() => server.child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }
  NodeFS.rmSync(server.home, { recursive: true, force: true });
}

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
      const server = yield* Effect.acquireRelease(Effect.promise(bootServer), (booted) =>
        Effect.promise(() => stopServer(booted)),
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
      const server = yield* Effect.acquireRelease(Effect.promise(bootServer), (booted) =>
        Effect.promise(() => stopServer(booted)),
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
                (view) => view.relayOrigin === new URL(fake.url).origin && view.state === "configured",
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
