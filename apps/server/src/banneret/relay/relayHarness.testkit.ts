// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a real HTTP relay (the fake) behind a recording forwarder.
import * as NodeHttp from "node:http";

import { type FakeRelay, startFakeRelay } from "@t3tools/banneret-relay-fake";
import * as Effect from "effect/Effect";

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
}

export interface Interception {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/**
 * Sits in front of the fake and records every request. It can be closed and reopened on the same
 * port (the fake itself always restarts empty), answer a request itself, or rewrite an answer.
 */
export interface Forwarder {
  readonly origin: string;
  readonly requests: Recorded[];
  intercept: ((request: Recorded) => Interception | undefined) | undefined;
  rewrite: ((request: Recorded, body: string) => string) | undefined;
  readonly close: () => Promise<void>;
  readonly reopen: () => Promise<void>;
}

const startForwarder = async (target: string): Promise<Forwarder> => {
  const targetUrl = new URL(target);
  const forwarder: Forwarder = {
    origin: "",
    requests: [],
    intercept: undefined,
    rewrite: undefined,
    close: async () => undefined,
    reopen: async () => undefined,
  };
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const recorded: Recorded = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
      };
      forwarder.requests.push(recorded);
      const intercepted = forwarder.intercept?.(recorded);
      if (intercepted !== undefined) {
        response.writeHead(intercepted.status, {
          "content-type": "application/json",
          ...intercepted.headers,
        });
        response.end(intercepted.body ?? "");
        return;
      }
      const upstream = NodeHttp.request(
        {
          host: targetUrl.hostname,
          port: targetUrl.port,
          method: recorded.method,
          path: recorded.url,
          // The Host header passes through: the fake builds browserUrl from it.
          headers: request.headers,
        },
        (reply) => {
          // An event stream passes through as it arrives; it never ends on its own.
          if (String(reply.headers["content-type"] ?? "").startsWith("text/event-stream")) {
            response.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(response);
            response.on("close", () => reply.destroy());
            return;
          }
          const replyChunks: Buffer[] = [];
          reply.on("data", (chunk: Buffer) => replyChunks.push(chunk));
          reply.on("end", () => {
            let text = Buffer.concat(replyChunks).toString("utf8");
            if (forwarder.rewrite) text = forwarder.rewrite(recorded, text);
            const headers = { ...reply.headers };
            delete headers["content-length"];
            delete headers["transfer-encoding"];
            response.writeHead(reply.statusCode ?? 502, headers);
            response.end(text);
          });
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      upstream.end(Buffer.concat(chunks));
    });
  });
  const listen = (port: number) =>
    new Promise<number>((resolve) => {
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  const port = await listen(0);
  return Object.assign(forwarder, {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    reopen: async () => {
      await listen(port);
    },
  });
};

export const withFake = <A, E, R>(
  body: (fake: FakeRelay, relay: Forwarder) => Effect.Effect<A, E, R>,
  options: Parameters<typeof startFakeRelay>[0] = {},
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const fake = await startFakeRelay({
        port: 0,
        autoApprove: false,
        retryAfterMs: 20,
        ...options,
      });
      const relay = await startForwarder(fake.url);
      return { fake, relay };
    }),
    ({ fake, relay }) => Effect.promise(() => Promise.all([relay.close(), fake.close()])),
  ).pipe(
    Effect.flatMap(({ fake, relay }) => body(fake, relay)),
    Effect.scoped,
  );
