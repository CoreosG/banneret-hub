// @effect-diagnostics globalDate:off globalFetch:off - a plain fetch client, so the suite runs against any relay.
import { type MachineKey, sign } from "./signing.ts";

/**
 * A minimal signed /relay/v1 client for the conformance suite. It speaks only HTTP, so the suite runs against
 * any relay: the fake, or the Go relay in test mode.
 */

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface SendOptions {
  readonly body?: unknown;
  /** Raw bytes to send instead of JSON-encoding `body`. */
  readonly rawBody?: Uint8Array;
  readonly token?: string;
  readonly device?: string;
  readonly counter?: string;
  readonly sentAt?: string;
  /** Sign these bytes instead of the request: proves the relay checks what it received. */
  readonly signOverride?: Partial<{ method: string; target: string; body: Uint8Array }>;
  readonly unsigned?: boolean;
  /** Sent as given, after the signing headers: a test can replace one of them with a malformed value. */
  readonly headers?: Record<string, string>;
}

export const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export class RelayClient {
  readonly origin: string;
  private lastCounter = 0n;

  constructor(origin: string) {
    this.origin = origin.replace(/\/+$/, "");
  }

  /** `unixMs * 1000 + seq`, strictly increasing for this client. */
  nextCounter(): string {
    const base = BigInt(Date.now()) * 1000n;
    this.lastCounter = base > this.lastCounter ? base : this.lastCounter + 1n;
    return this.lastCounter.toString();
  }

  now(): string {
    return rfc3339(Date.now());
  }

  async send(
    key: MachineKey,
    method: string,
    target: string,
    options: SendOptions = {},
  ): Promise<Reply> {
    const response = await this.raw(key, method, target, options);
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, headers: response.headers, body };
  }

  /** The unread response, for the event stream. */
  raw(
    key: MachineKey,
    method: string,
    target: string,
    options: SendOptions & { signal?: AbortSignal } = {},
  ): Promise<Response> {
    const bytes =
      options.rawBody ??
      (options.body === undefined
        ? new Uint8Array()
        : Buffer.from(JSON.stringify(options.body), "utf8"));
    const headers: Record<string, string> = {};
    if (bytes.length > 0) headers["content-type"] = "application/json";
    if (!options.unsigned) {
      const counter = options.counter ?? (options.token === undefined ? "0" : this.nextCounter());
      const sentAt = options.sentAt ?? this.now();
      const device = options.device ?? "";
      headers["X-Banneret-Counter"] = counter;
      headers["X-Banneret-Sent-At"] = sentAt;
      headers["X-Banneret-Signature"] = sign(key, {
        method: options.signOverride?.method ?? method,
        target: options.signOverride?.target ?? target,
        device,
        counter,
        sentAt,
        body: options.signOverride?.body ?? bytes,
      });
    }
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    if (options.device !== undefined) headers["X-Banneret-Device"] = options.device;
    Object.assign(headers, options.headers);
    return fetch(`${this.origin}${target}`, {
      method,
      headers,
      ...(bytes.length > 0 ? { body: Buffer.from(bytes) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** A call to the relay's test control surface (FAKE.md); never part of /relay/v1. */
  async control(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.origin}/conformance/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const reply = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(`control ${path} failed: ${JSON.stringify(reply)}`);
    return reply;
  }
}

export interface SseEvent {
  readonly id: string | undefined;
  readonly event: string;
  readonly data: unknown;
}

/** Reads server-sent events one at a time from a response body. */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  closed = false;

  constructor(response: Response) {
    if (!response.body) throw new Error("the event stream has no body");
    this.reader = response.body.getReader();
  }

  /** The next event, or null when the relay closes the stream. Comment lines are skipped. */
  async next(): Promise<SseEvent | null> {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end !== -1) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const fields = new Map<string, string>();
        for (const line of block.split("\n")) {
          if (line.startsWith(":") || line.length === 0) continue;
          const colon = line.indexOf(":");
          const name = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          fields.set(
            name,
            fields.has(name) && name === "data" ? `${fields.get(name)}\n${value}` : value,
          );
        }
        const event = fields.get("event");
        if (event === undefined) continue;
        return { id: fields.get("id"), event, data: JSON.parse(fields.get("data") ?? "null") };
      }
      const chunk = await this.reader.read();
      if (chunk.done) {
        this.closed = true;
        return null;
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}
