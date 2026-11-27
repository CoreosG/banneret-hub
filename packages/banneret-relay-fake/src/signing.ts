// @effect-diagnostics nodeBuiltinImport:off - Ed25519 comes from node:crypto; this package has no Effect runtime.
import * as NodeCrypto from "node:crypto";

/** Request signing as docs/banneret/relay-v1/README.md specifies it. */

export interface SigningParts {
  readonly method: string;
  /** Escaped path, plus "?" and the raw query when there is one: exactly the request target as sent. */
  readonly target: string;
  /** The X-Banneret-Device value; empty on enrolment calls. */
  readonly device: string;
  readonly counter: string;
  readonly sentAt: string;
  readonly body: Uint8Array;
}

export const signingInput = (parts: SigningParts): Buffer =>
  Buffer.concat([
    Buffer.from(
      `relay/v1\n${parts.method}\n${parts.target}\n${parts.device}\n${parts.counter}\n${parts.sentAt}\n`,
      "utf8",
    ),
    Buffer.from(parts.body),
  ]);

const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
// PKCS#8 and SPKI wrappers for a raw 32-byte Ed25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface MachineKey {
  readonly privateKey: NodeCrypto.KeyObject;
  /** Standard base64 of the raw 32-byte public key, as `publicKey` in the start request. */
  readonly publicKey: string;
}

export const rawPublicKey = (key: NodeCrypto.KeyObject): string =>
  key.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length).toString("base64");

export const keyFromSeed = (seed: Uint8Array): MachineKey => {
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const privateKey = NodeCrypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKey: rawPublicKey(NodeCrypto.createPublicKey(privateKey)) };
};

export const generateMachineKey = (): MachineKey => keyFromSeed(NodeCrypto.randomBytes(32));

/** Null when the text is not the standard base64 of a 32-byte key. */
export const publicKeyFromBase64 = (text: string): NodeCrypto.KeyObject | null => {
  if (!PUBLIC_KEY_PATTERN.test(text)) return null;
  const raw = Buffer.from(text, "base64");
  if (raw.length !== 32) return null;
  try {
    return NodeCrypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
};

export const sign = (key: MachineKey, parts: SigningParts): string =>
  NodeCrypto.sign(null, signingInput(parts), key.privateKey).toString("base64");

export const verify = (
  publicKey: NodeCrypto.KeyObject,
  parts: SigningParts,
  signature: string,
): boolean => {
  if (!SIGNATURE_PATTERN.test(signature)) return false;
  const raw = Buffer.from(signature, "base64");
  if (raw.length !== 64) return false;
  return NodeCrypto.verify(null, signingInput(parts), publicKey, raw);
};
