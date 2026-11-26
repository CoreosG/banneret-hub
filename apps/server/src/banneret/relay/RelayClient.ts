// @effect-diagnostics globalFetch:off globalFetchInEffect:off - one bounded fetch per relay call; redirects, size and time are capped here.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type MachineKey, rfc3339, sign } from "./RelaySigning.ts";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Any relay call that did not answer 2xx (or 304). `status` 0 means no HTTP answer at all; `code`
 * is the relay's error code, or `network`, `redirect`, `too_large_response`, `bad_response`.
 */
export class RelayCallError extends Schema.TaggedError<RelayCallError>()("RelayCallError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  retryAfterMs: Schema.optional(Schema.Number),
  details: Schema.optional(Schema.Unknown),
}) {}

export interface RelayReply {
  readonly status: number;
  readonly etag: string | undefined;
  readonly body: unknown;
  /** The exact body bytes, for content-addressed snapshot files. */
  readonly bytes: Uint8Array;
}

export type RelaySigner =
  /** Enrolment calls: no token or device, counter 0, signed with the pairing's key. */
  | { readonly kind: "enrolment"; readonly key: MachineKey }
  | {
      readonly kind: "device";
      readonly key: MachineKey;
      readonly token: string;
      readonly machineId: string;
      readonly counter: bigint;
    };

export interface RelayRequest {
  readonly origin: string;
  readonly method: "GET" | "POST" | "DELETE";
  /** Path and query exactly as sent and signed. */
  readonly target: string;
  readonly body?: unknown;
  readonly signer?: RelaySigner;
  readonly ifNoneMatch?: string;
  /** Snapshot files may be larger than other answers. */
  readonly maxResponseBytes?: number;
  readonly nowMs: number;
}

const jsonBytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), "utf8");

const network = (message: string) =>
  new RelayCallError({ status: 0, code: "network", message, retryable: true });

async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const retryAfterMs = (header: string | null): number | undefined => {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

const parseJson = (bytes: Uint8Array): unknown => {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
};

const errorFields = (body: unknown) => {
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error: unknown }).error
      : undefined;
  if (typeof error !== "object" || error === null) return {};
  const fields = error as Record<string, unknown>;
  return {
    code: typeof fields.code === "string" ? fields.code : undefined,
    message: typeof fields.message === "string" ? fields.message.slice(0, 500) : undefined,
    details: fields.details,
  };
};

/** One relay call: no redirects, 10 s, a 1 MiB response at most unless the caller allows more. */
export const relayFetch = Effect.fn("BanneretRelay.fetch")(function* (request: RelayRequest) {
  const bodyBytes = request.body === undefined ? new Uint8Array() : jsonBytes(request.body);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  if (request.ifNoneMatch !== undefined) headers["If-None-Match"] = request.ifNoneMatch;
  if (request.signer !== undefined) {
    const counter = request.signer.kind === "device" ? request.signer.counter.toString() : "0";
    const device = request.signer.kind === "device" ? request.signer.machineId : "";
    const sentAt = rfc3339(request.nowMs);
    headers["X-Banneret-Counter"] = counter;
    headers["X-Banneret-Sent-At"] = sentAt;
    headers["X-Banneret-Signature"] = sign(request.signer.key, {
      method: request.method,
      target: request.target,
      device,
      counter,
      sentAt,
      body: bodyBytes,
    });
    if (request.signer.kind === "device") {
      headers.Authorization = `Bearer ${request.signer.token}`;
      headers["X-Banneret-Device"] = device;
    }
  }

  const { response, bytes } = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${request.origin}${request.target}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: bodyBytes }),
        // A relay that redirects is refused, never followed: the next hop would get the token.
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      return {
        response,
        bytes: await readCapped(response, request.maxResponseBytes ?? MAX_RESPONSE_BYTES),
      };
    },
    catch: () => network("The relay could not be reached."),
  });

  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    return yield* new RelayCallError({
      status: response.status,
      code: "redirect",
      message: "The relay answered with a redirect, which Banneret Hub does not follow.",
      retryable: false,
    });
  }
  if (bytes === null) {
    return yield* new RelayCallError({
      status: response.status,
      code: "too_large_response",
      message: "The relay's answer was too large.",
      retryable: false,
    });
  }
  const body = parseJson(bytes);
  if (response.status >= 200 && response.status < 300) {
    if (body === undefined) {
      return yield* new RelayCallError({
        status: response.status,
        code: "bad_response",
        message: "The relay's answer was not valid JSON.",
        retryable: true,
      });
    }
    return {
      status: response.status,
      etag: response.headers.get("etag") ?? undefined,
      body,
      bytes,
    };
  }
  if (response.status === 304) {
    return {
      status: 304,
      etag: response.headers.get("etag") ?? undefined,
      body: null,
      bytes: new Uint8Array(),
    };
  }
  const fields = errorFields(body);
  const status = response.status;
  // Unknown codes are handled by their HTTP status alone.
  const retryable = status === 429 || status >= 500;
  const retryAfter = retryAfterMs(response.headers.get("retry-after"));
  return yield* new RelayCallError({
    status,
    code: fields.code ?? `http_${status}`,
    message: fields.message ?? `The relay answered ${status}.`,
    retryable,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    ...(fields.details === undefined ? {} : { details: fields.details }),
  });
});
