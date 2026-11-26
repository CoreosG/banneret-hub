// @effect-diagnostics nodeBuiltinImport:off - Ed25519 signing is synchronous node:crypto; Effect has no Ed25519.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";

/**
 * Request signing as docs/banneret/relay-v1/README.md specifies it. The fake relay has its own copy;
 * this one ships, so release builds never include the fake.
 */
export interface SigningParts {
  readonly method: string;
  /** The request target exactly as sent: path, plus "?" and the query when there is one. */
  readonly target: string;
  /** The X-Banneret-Device value; empty on enrolment calls. */
  readonly device: string;
  readonly counter: string;
  readonly sentAt: string;
  readonly body: Uint8Array;
}

export const signingInput = (parts: SigningParts): Uint8Array =>
  Buffer.concat([
    Buffer.from(
      `relay/v1\n${parts.method}\n${parts.target}\n${parts.device}\n${parts.counter}\n${parts.sentAt}\n`,
      "utf8",
    ),
    Buffer.from(parts.body),
  ]);

// PKCS#8 and SPKI wrappers for a raw 32-byte Ed25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX_LENGTH = 12;

export interface MachineKey {
  readonly privateKey: NodeCrypto.KeyObject;
  /** Standard base64 of the raw 32-byte public key. */
  readonly publicKey: string;
}

export const keyFromSeed = (seed: Uint8Array): MachineKey => {
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const privateKey = NodeCrypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = NodeCrypto.createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(SPKI_PREFIX_LENGTH)
    .toString("base64");
  return { privateKey, publicKey };
};

export const sign = (key: MachineKey, parts: SigningParts): string =>
  NodeCrypto.sign(null, signingInput(parts), key.privateKey).toString("base64");

/** RFC 3339 UTC to the second, ending in `Z`. */
export const rfc3339 = (ms: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(ms)).replace(/\.\d{3}Z$/, "Z");

/**
 * The time-based counter: Unix ms × 1000, strictly increasing in memory. `mark` is the highest
 * counter handed out, which the enrolment saves so a restart after a backward clock step waits.
 */
export class RelayCounter {
  private last: bigint;
  private readonly nowMs: () => number;

  constructor(nowMs: () => number, mark = 0n) {
    this.nowMs = nowMs;
    this.last = mark;
  }

  next(): bigint {
    const base = BigInt(this.nowMs()) * 1000n;
    this.last = base > this.last ? base : this.last + 1n;
    return this.last;
  }

  get mark(): bigint {
    return this.last;
  }
}

/** Longest wait for the clock to pass a saved counter before reporting a wrong clock. */
const MAX_CLOCK_WAIT_MS = 120_000;

/**
 * How long to wait before signing, so the first counter is above `mark`: 0 when the clock is
 * already past it, or "clock_wrong" when the wait would exceed `maxWaitMs`.
 */
export function waitBeforeSigning(
  nowMs: number,
  mark: bigint,
  maxWaitMs = MAX_CLOCK_WAIT_MS,
): number | "clock_wrong" {
  if (BigInt(nowMs) * 1000n > mark) return 0;
  const waitMs = Number(mark / 1000n) - nowMs + 1;
  return waitMs > maxWaitMs ? "clock_wrong" : waitMs;
}
