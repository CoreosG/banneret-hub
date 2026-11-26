// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - a plain node:http test double with no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { publicKeyFromBase64, verify } from "./signing.ts";
import { loadSpec, type SchemaName } from "./spec.ts";

/**
 * A fake /relay/v1 relay: a test double and conformance target, never a production server. Everything lives in
 * memory, so every start is an empty store. Enrolment has no browser page; tests confirm, approve and refuse
 * pairings through the methods below or the HTTP control surface under /conformance/v1 (see FAKE.md).
 */

export type Role = "founder" | "limited_staff";
export type Refusal =
  | "declined"
  | "not_staff"
  | "network_identity_mismatch"
  | "environment_enrolled";
type Expiry = "code_expired" | "too_many_attempts" | "approval_expired";
type PairingState = "pending" | "awaiting_approval" | "approved" | "refused" | "expired";
type ErrorCode =
  | "malformed"
  | "too_large"
  | "unauthenticated"
  | "token_revoked"
  | "bad_signature"
  | "signature_invalid"
  | "clock_skew"
  | "counter_reused"
  | "forbidden"
  | "network_identity_mismatch"
  | "not_found"
  | "internal";

export interface PersonInput {
  readonly login: string;
  readonly role?: Role;
  /** The person's registered network identity, checked only when `networkIdentityHeader` is set. */
  readonly networkIdentity?: string;
  /** Hold the pairing in `awaiting_approval` until `approvePairing` (a person new to the relay). */
  readonly awaitFounder?: boolean;
}

export interface FakeRelayOptions {
  /** 0 (the default) picks a free port. */
  readonly port?: number;
  readonly host?: string;
  readonly displayName?: string;
  /** Approve every pairing as `defaultPerson` as soon as it starts. Default true; the conformance suite turns it off. */
  readonly autoApprove?: boolean;
  readonly defaultPerson?: PersonInput;
  /** The optional network identity check: the request header that carries the caller's identity. Off by default. */
  readonly networkIdentityHeader?: string;
  readonly retryAfterMs?: number;
  /** Interval of the SSE comment line; the spec says 25 seconds. */
  readonly sseCommentMs?: number;
  /** The clock that ages the event log for the 24-hour resume bound. Tests move it to prove the reset. */
  readonly eventClock?: () => number;
  /** Prints refused requests and invalid responses. */
  readonly log?: (line: string) => void;
}

interface Person {
  readonly id: string;
  readonly login: string;
  role: Role;
  networkIdentity: string | null;
  removed: boolean;
}

interface MachineFacts {
  readonly environmentId: string;
  readonly label: string;
  readonly kind: string;
  readonly hostname: string;
  readonly os: string;
  readonly hubVersion: string;
  readonly policyFingerprint: string | null;
  readonly sandbox: { readonly enabled: boolean; readonly image: string | null };
}

interface ActivityFact {
  readonly sessionId: string;
  readonly threadId: string;
  readonly branch?: string;
  readonly state: "working" | "waiting" | "idle" | "stopped";
  readonly lastSeenAt: string;
}

interface Pairing {
  readonly id: string;
  readonly code: string;
  readonly publicKey: NodeCrypto.KeyObject;
  readonly machine: MachineFacts;
  readonly networkIdentity: string | null;
  state: PairingState;
  expiresAt: number;
  wrongCodes: number;
  reason?: Refusal | Expiry;
  personId?: string;
  machineId?: string;
  /** Held only until the first poll after approval. */
  token?: string;
}

interface Machine {
  readonly id: string;
  readonly personId: string;
  readonly publicKey: NodeCrypto.KeyObject;
  readonly tokenHash: string;
  readonly enrolledAt: number;
  facts: MachineFacts;
  sessions: ReadonlyArray<ActivityFact>;
  lastHeardAt: number | null;
  /** The 256 highest counters accepted, ascending. */
  readonly counters: bigint[];
  revokedAt: number | null;
}

interface NeedsItem {
  /** Recording order: the tie-break within a class and createdAt. Not sent. */
  readonly seq: number;
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly createdAt: string;
  readonly deepLink?: { readonly environmentId: string; readonly threadId: string };
}

interface RelayEvent {
  readonly id: number;
  readonly at: number;
  readonly type: string;
  readonly data: unknown;
  /** Null: every person. */
  readonly personId: string | null;
}

interface Stream {
  readonly personId: string;
  readonly machineId: string;
  readonly response: NodeHttp.ServerResponse;
}

class RelayError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

const STATUS: Record<ErrorCode, number> = {
  malformed: 400,
  too_large: 413,
  unauthenticated: 401,
  token_revoked: 401,
  bad_signature: 401,
  signature_invalid: 401,
  clock_skew: 401,
  counter_reused: 401,
  forbidden: 403,
  network_identity_mismatch: 403,
  not_found: 404,
  internal: 500,
};

const PREFIX = "/relay/v1";
const CONTROL_PREFIX = "/conformance/v1";
const MAX_BODY_BYTES = 1024 * 1024;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const PAIRING_MS = 10 * 60 * 1000;
const AWAITING_APPROVAL_MS = 7 * 24 * 60 * 60 * 1000;
const WRONG_CODES_BEFORE_EXPIRY = 5;
const NOT_HEARD_FROM_MS = 90 * 1000;
const HEARTBEAT_SECONDS = 30;
const EVENT_LOG_SIZE = 1000;
const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const TODAY_BLOCK_MAX = 20;
const COUNTER_MAX = 9223372036854775807n;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COUNTER_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const COUNTER_WINDOW = 256;
// The Timestamp schema: RFC 3339 in UTC, ending in Z.
const SENT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const spec = loadSpec();

const randomId = (prefix: string) =>
  `${prefix}_${NodeCrypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const confirmCode = () =>
  Array.from(NodeCrypto.randomBytes(8), (byte) => BASE32[byte % 32]).join("");
const hashToken = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
const iso = (ms: number) =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

const encodeCursor = (offset: number) =>
  `c_${Buffer.from(JSON.stringify({ o: offset })).toString("base64url")}`;
const decodeCursor = (cursor: string): number => {
  try {
    if (!cursor.startsWith("c_")) throw new Error("prefix");
    const parsed = JSON.parse(Buffer.from(cursor.slice(2), "base64url").toString("utf8")) as {
      o?: unknown;
    };
    if (typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0)
      return parsed.o;
  } catch {
    // Falls through to the refusal below.
  }
  throw new RelayError("malformed", "The cursor is not one this relay issued.", {
    field: "cursor",
  });
};

const pageParams = (query: URLSearchParams) => {
  const cursor = query.get("cursor");
  const limitText = query.get("limit");
  if (cursor !== null && (cursor.length < 1 || cursor.length > 512)) {
    throw new RelayError("malformed", "The cursor is too long.", { field: "cursor" });
  }
  let limit = 50;
  if (limitText !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100) {
      throw new RelayError("malformed", "limit must be a whole number from 1 to 100.", {
        field: "limit",
      });
    }
    limit = Number(limitText);
  }
  return { offset: cursor === null ? 0 : decodeCursor(cursor), limit };
};

// GET /needs order: the class of the kind (README "Needs you"), then oldest first, then recording order.
const NEEDS_CLASS: Readonly<Record<string, number>> = {
  thread_question: 1,
  thread_approval: 1,
  pull_request: 2,
  promotion: 2,
  founder_question: 2,
  health: 2,
  mention: 3,
  suggestion: 4,
};
const UNKNOWN_KIND_CLASS = 5;
const needsClass = (kind: string) => NEEDS_CLASS[kind] ?? UNKNOWN_KIND_CLASS;
const byUrgency = (items: ReadonlyArray<NeedsItem>) =>
  items.toSorted(
    (a, b) =>
      needsClass(a.kind) - needsClass(b.kind) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.seq - b.seq,
  );
const needsView = ({ seq: _seq, ...item }: NeedsItem) => item;

const page = <T>(items: ReadonlyArray<T>, offset: number, limit: number) => ({
  items: items.slice(offset, offset + limit),
  nextCursor: offset + limit < items.length ? encodeCursor(offset + limit) : null,
});

const headerValue = (request: NodeHttp.IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const readBody = (request: NodeHttp.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) {
        reject(new RelayError("too_large", "The request body is larger than 1 MiB."));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    request.on("error", reject);
  });

const parseJson = (body: Buffer, schema: SchemaName): unknown => {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new RelayError("malformed", "The body is not JSON.");
  }
  const problem = spec.check(schema, value);
  if (problem !== null) {
    throw new RelayError("malformed", "The body does not match the relay v1 schema.", {
      schema,
      problem: problem.slice(0, 400),
    });
  }
  return value;
};

export interface FakeRelay {
  /** The relay's origin, such as http://127.0.0.1:41234. */
  readonly url: string;
  /** `${url}/relay/v1`. */
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  /** The person types `code` on the relay page after signing in. */
  readonly confirmPairing: (pairingId: string, code: string, person: PersonInput) => PairingState;
  /** A founder approves a pairing waiting in `awaiting_approval`. */
  readonly approvePairing: (pairingId: string) => PairingState;
  readonly refusePairing: (pairingId: string, reason: Refusal) => PairingState;
  readonly expirePairing: (pairingId: string) => PairingState;
  /** Confirms by confirm code with the right code, then approves if a founder must. */
  readonly approve: (confirmCode: string, person?: PersonInput) => PairingState;
  readonly refuse: (confirmCode: string, reason: Refusal) => PairingState;
  /** Adds needs-you items for the machine's owner and sends `needs.changed` (and `mention` for mentions). */
  readonly seedNeeds: (machineId: string, count: number, kind?: string) => void;
  /** Changes the capabilities document and sends `capabilities.changed`. */
  readonly bumpCapabilities: () => string;
  readonly publishBundle: (bundleSha: string) => void;
  /** Removes a person: their machines are revoked and `staff.removed` goes to everyone. */
  readonly removeStaff: (login: string) => void;
}

export const startFakeRelay = async (options: FakeRelayOptions = {}): Promise<FakeRelay> => {
  const startedAt = Date.now();
  const log = options.log ?? (() => undefined);
  const autoApprove = options.autoApprove ?? true;
  const defaultPerson: PersonInput = options.defaultPerson ?? {
    login: "ada-example",
    role: "founder",
  };
  const retryAfterMs = options.retryAfterMs ?? 2000;
  const identityHeader = options.networkIdentityHeader;

  const people = new Map<string, Person>();
  const peopleByLogin = new Map<string, Person>();
  const pairings = new Map<string, Pairing>();
  const machines = new Map<string, Machine>();
  const machinesByToken = new Map<string, Machine>();
  const needs = new Map<string, NeedsItem[]>();
  const lastVisit = new Map<string, number>();
  const events: RelayEvent[] = [];
  const streams = new Set<Stream>();
  const eventClock = options.eventClock ?? (() => Date.now());
  let nextEventId = 1;
  let nextNeedsSeq = 1;
  let capabilitiesRevision = 1;
  const capabilitiesVersion = () => `c-${capabilitiesRevision}`;

  const personFor = (input: PersonInput): Person => {
    const existing = peopleByLogin.get(input.login);
    if (existing && !existing.removed) {
      if (input.role) existing.role = input.role;
      if (input.networkIdentity !== undefined) existing.networkIdentity = input.networkIdentity;
      return existing;
    }
    const person: Person = {
      id: randomId("p"),
      login: input.login,
      role: input.role ?? "limited_staff",
      networkIdentity: input.networkIdentity ?? null,
      removed: false,
    };
    people.set(person.id, person);
    peopleByLogin.set(person.login, person);
    return person;
  };

  const writeEvent = (stream: Stream, event: RelayEvent) => {
    stream.response.write(
      `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
    );
  };

  // Resume reaches back over the smaller of the last 1000 events and the retention window (24 hours).
  const pruneEvents = () => {
    const oldestKept = eventClock() - EVENT_RETENTION_MS;
    while (
      events.length > EVENT_LOG_SIZE ||
      (events[0] !== undefined && events[0].at < oldestKept)
    ) {
      events.shift();
    }
  };

  const emit = (type: string, schema: SchemaName, data: unknown, personId: string | null) => {
    const problem = spec.check(schema, data);
    if (problem !== null) throw new Error(`fake relay built an invalid ${type} event: ${problem}`);
    const event: RelayEvent = { id: nextEventId++, at: eventClock(), type, data, personId };
    events.push(event);
    pruneEvents();
    for (const stream of streams) {
      if (personId === null || stream.personId === personId) writeEvent(stream, event);
    }
  };

  const sendOnly = (stream: Stream, type: string, schema: SchemaName, data: unknown) => {
    const problem = spec.check(schema, data);
    if (problem !== null) throw new Error(`fake relay built an invalid ${type} event: ${problem}`);
    writeEvent(stream, {
      id: nextEventId++,
      at: eventClock(),
      type,
      data,
      personId: stream.personId,
    });
  };

  const closeStreams = (match: (stream: Stream) => boolean) => {
    for (const stream of streams) {
      if (match(stream)) {
        streams.delete(stream);
        stream.response.end();
      }
    }
  };

  const revokeMachine = (machine: Machine) => {
    machine.revokedAt = Date.now();
    closeStreams((stream) => stream.machineId === machine.id);
  };

  const isOpen = (pairing: Pairing) =>
    pairing.state === "pending" || pairing.state === "awaiting_approval";

  const expire = (pairing: Pairing, reason: Expiry, at: number) => {
    pairing.state = "expired";
    pairing.reason = reason;
    pairing.expiresAt = at;
  };

  const settleExpiry = (pairing: Pairing) => {
    if (isOpen(pairing) && Date.now() > pairing.expiresAt) {
      expire(
        pairing,
        pairing.state === "pending" ? "code_expired" : "approval_expired",
        pairing.expiresAt,
      );
    }
  };

  const finishApproval = (pairing: Pairing, person: Person) => {
    // One live machine per environment. The same owner enrolling again replaces the old machine.
    for (const machine of machines.values()) {
      if (
        machine.revokedAt !== null ||
        machine.facts.environmentId !== pairing.machine.environmentId
      )
        continue;
      if (machine.personId !== person.id) {
        pairing.state = "refused";
        pairing.reason = "environment_enrolled";
        return;
      }
      revokeMachine(machine);
    }
    const token = `rdt_${NodeCrypto.randomBytes(32).toString("base64url")}`;
    const machine: Machine = {
      id: randomId("m"),
      personId: person.id,
      publicKey: pairing.publicKey,
      tokenHash: hashToken(token),
      enrolledAt: Date.now(),
      facts: pairing.machine,
      sessions: [],
      lastHeardAt: null,
      counters: [],
      revokedAt: null,
    };
    machines.set(machine.id, machine);
    machinesByToken.set(machine.tokenHash, machine);
    pairing.state = "approved";
    pairing.machineId = machine.id;
    pairing.token = token;
  };

  const pairingById = (pairingId: string): Pairing => {
    const pairing = pairings.get(pairingId);
    if (!pairing) throw new RelayError("not_found", "No such pairing.");
    settleExpiry(pairing);
    return pairing;
  };

  const confirmPairing = (pairingId: string, code: string, input: PersonInput): PairingState => {
    const pairing = pairingById(pairingId);
    if (pairing.state !== "pending") return pairing.state;
    if (code !== pairing.code) {
      pairing.wrongCodes += 1;
      if (pairing.wrongCodes >= WRONG_CODES_BEFORE_EXPIRY) {
        expire(pairing, "too_many_attempts", Date.now());
      }
      return pairing.state;
    }
    const isNew =
      !peopleByLogin.get(input.login) || peopleByLogin.get(input.login)?.removed === true;
    const person = personFor(input);
    pairing.personId = person.id;
    if (identityHeader !== undefined && pairing.networkIdentity !== person.networkIdentity) {
      pairing.state = "refused";
      pairing.reason = "network_identity_mismatch";
      return pairing.state;
    }
    if (input.awaitFounder === true && isNew) {
      pairing.state = "awaiting_approval";
      pairing.expiresAt = Date.now() + AWAITING_APPROVAL_MS;
      return pairing.state;
    }
    finishApproval(pairing, person);
    return pairing.state;
  };

  const approvePairing = (pairingId: string): PairingState => {
    const pairing = pairingById(pairingId);
    const person = pairing.personId ? people.get(pairing.personId) : undefined;
    if (pairing.state === "awaiting_approval" && person) finishApproval(pairing, person);
    return pairing.state;
  };

  const refusePairing = (pairingId: string, reason: Refusal): PairingState => {
    const pairing = pairingById(pairingId);
    if (isOpen(pairing)) {
      pairing.state = "refused";
      pairing.reason = reason;
    }
    return pairing.state;
  };

  const expirePairing = (pairingId: string): PairingState => {
    const pairing = pairingById(pairingId);
    if (isOpen(pairing)) {
      expire(
        pairing,
        pairing.state === "pending" ? "code_expired" : "approval_expired",
        Date.now(),
      );
    }
    return pairing.state;
  };

  const pairingByCode = (code: string): Pairing => {
    for (const pairing of pairings.values()) if (pairing.code === code) return pairing;
    throw new RelayError("not_found", "No pairing has that confirm code.");
  };

  interface Signed {
    readonly counter: string;
    readonly sentAt: string;
    readonly signature: string;
  }

  const signingHeaders = (request: NodeHttp.IncomingMessage): Signed => {
    const counter = headerValue(request, "X-Banneret-Counter");
    const sentAt = headerValue(request, "X-Banneret-Sent-At");
    const signature = headerValue(request, "X-Banneret-Signature");
    const missing = (header: string) =>
      new RelayError("bad_signature", `${header} is missing or malformed.`, { header });
    if (counter === undefined || !COUNTER_PATTERN.test(counter) || BigInt(counter) > COUNTER_MAX) {
      throw missing("X-Banneret-Counter");
    }
    if (sentAt === undefined || !SENT_AT_PATTERN.test(sentAt) || Number.isNaN(Date.parse(sentAt))) {
      throw missing("X-Banneret-Sent-At");
    }
    if (signature === undefined || !SIGNATURE_PATTERN.test(signature)) {
      throw missing("X-Banneret-Signature");
    }
    return { counter, sentAt, signature };
  };

  const checkSignature = (
    request: NodeHttp.IncomingMessage,
    signed: Signed,
    publicKey: NodeCrypto.KeyObject,
    device: string,
    body: Buffer,
  ) => {
    const parts = {
      method: request.method ?? "GET",
      target: request.url ?? "/",
      device,
      counter: signed.counter,
      sentAt: signed.sentAt,
      body,
    };
    if (!verify(publicKey, parts, signed.signature)) {
      throw new RelayError("signature_invalid", "The request signature does not verify.");
    }
    if (Math.abs(Date.now() - Date.parse(signed.sentAt)) > CLOCK_SKEW_MS) {
      throw new RelayError(
        "clock_skew",
        "X-Banneret-Sent-At is more than 2 minutes from the relay's clock.",
        {
          header: "X-Banneret-Sent-At",
        },
      );
    }
  };

  const enrolmentSignature = (
    request: NodeHttp.IncomingMessage,
    publicKey: NodeCrypto.KeyObject,
    body: Buffer,
  ) => {
    if (
      headerValue(request, "Authorization") !== undefined ||
      headerValue(request, "X-Banneret-Device") !== undefined
    ) {
      throw new RelayError(
        "unauthenticated",
        "Enrolment calls carry no Authorization and no X-Banneret-Device.",
      );
    }
    const signed = signingHeaders(request);
    if (signed.counter !== "0") {
      throw new RelayError("bad_signature", "Enrolment calls use counter 0.", {
        header: "X-Banneret-Counter",
      });
    }
    checkSignature(request, signed, publicKey, "", body);
  };

  interface Caller {
    readonly machine: Machine;
    readonly person: Person;
  }

  const authenticate = (request: NodeHttp.IncomingMessage, body: Buffer): Caller => {
    const authorization = headerValue(request, "Authorization");
    const match = authorization === undefined ? null : /^Bearer (\S+)$/.exec(authorization);
    if (!match?.[1]) {
      throw new RelayError("unauthenticated", "A device token is required.", {
        header: "Authorization",
      });
    }
    const machine = machinesByToken.get(hashToken(match[1]));
    if (!machine) throw new RelayError("unauthenticated", "Unknown device token.");
    if (machine.revokedAt !== null)
      throw new RelayError("token_revoked", "This machine was revoked; enrol again.");
    const device = headerValue(request, "X-Banneret-Device");
    if (device === undefined || !ID_PATTERN.test(device) || device !== machine.id) {
      throw new RelayError(
        "unauthenticated",
        "X-Banneret-Device does not name this token's machine.",
        {
          header: "X-Banneret-Device",
        },
      );
    }
    const signed = signingHeaders(request);
    checkSignature(request, signed, machine.publicKey, device, body);
    // The window holds the 256 highest counters accepted. Refused: a repeat, or, once the window is full, a
    // counter below its lowest (the 256th highest). Anything else is accepted.
    const counter = BigInt(signed.counter);
    const lowest = machine.counters[0];
    const full = machine.counters.length >= COUNTER_WINDOW;
    if (machine.counters.includes(counter) || (full && lowest !== undefined && counter < lowest)) {
      throw new RelayError("counter_reused", "This request was already received.", {
        header: "X-Banneret-Counter",
      });
    }
    const person = people.get(machine.personId);
    if (!person || person.removed)
      throw new RelayError("token_revoked", "This person was removed.");
    if (
      identityHeader !== undefined &&
      headerValue(request, identityHeader) !== person.networkIdentity
    ) {
      throw new RelayError(
        "network_identity_mismatch",
        "The caller's network identity is not the machine owner's.",
      );
    }
    const at = machine.counters.findIndex((value) => value > counter);
    machine.counters.splice(at === -1 ? machine.counters.length : at, 0, counter);
    if (machine.counters.length > COUNTER_WINDOW) machine.counters.shift();
    return { machine, person };
  };

  const publicCapabilities = () => ({
    protocol: "1.0",
    displayName: options.displayName ?? "Example Company",
    iconUrl: null,
    enrolment: { start: "/relay/v1/enroll/start", browser: "/enroll" },
  });

  const machineView = (machine: Machine, caller: Caller) => {
    const owner = people.get(machine.personId);
    const revoked = machine.revokedAt !== null;
    return {
      id: machine.id,
      environmentId: machine.facts.environmentId,
      ownerId: machine.personId,
      ownerLogin: owner?.login ?? "unknown",
      label: machine.facts.label,
      kind: machine.facts.kind,
      hostname: machine.facts.hostname,
      os: machine.facts.os,
      hubVersion: machine.facts.hubVersion,
      policyFingerprint: machine.facts.policyFingerprint,
      sandbox: machine.facts.sandbox,
      enrolledAt: iso(machine.enrolledAt),
      lastHeardAt: machine.lastHeardAt === null ? null : iso(machine.lastHeardAt),
      connected:
        !revoked &&
        machine.lastHeardAt !== null &&
        Date.now() - machine.lastHeardAt <= NOT_HEARD_FROM_MS,
      revocable:
        !revoked && (machine.personId === caller.person.id || caller.person.role === "founder"),
      ...(machine.revokedAt === null ? {} : { revokedAt: iso(machine.revokedAt) }),
    };
  };

  const liveMachines = () =>
    [...machines.values()]
      .filter((machine) => machine.revokedAt === null)
      .toSorted(
        (a, b) =>
          (b.lastHeardAt ?? -1) - (a.lastHeardAt ?? -1) ||
          b.enrolledAt - a.enrolledAt ||
          a.id.localeCompare(b.id),
      );

  // Every enrolled person sees every live machine; revoked ones only their owner and founders, after the live ones.
  const visibleMachines = (caller: Caller) => [
    ...liveMachines(),
    ...[...machines.values()]
      .filter(
        (machine) =>
          machine.revokedAt !== null &&
          (machine.personId === caller.person.id || caller.person.role === "founder"),
      )
      .toSorted((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0) || a.id.localeCompare(b.id)),
  ];

  const notConfigured = (source: string) => ({
    state: "not_measured",
    items: [],
    notMeasured: [{ source, reason: "not_configured", since: iso(startedAt) }],
  });

  const today = (caller: Caller) => {
    const now = Date.now();
    const own = byUrgency(needs.get(caller.person.id) ?? []).map(needsView);
    const working = liveMachines().flatMap((machine) => {
      const person = people.get(machine.personId);
      const live = machine.sessions.filter((session) => session.state !== "stopped");
      const first = live[0];
      if (!person || !first) return [];
      const heard = machine.lastHeardAt !== null && now - machine.lastHeardAt <= NOT_HEARD_FROM_MS;
      return [
        {
          person: { id: person.id, login: person.login },
          ...(first.branch === undefined ? {} : { branch: first.branch }),
          sessions: live.length,
          state: heard ? first.state : "not_heard_from",
          lastActivityAt:
            live
              .map((session) => session.lastSeenAt)
              .toSorted()
              .at(-1) ?? first.lastSeenAt,
          deepLink: { environmentId: machine.facts.environmentId, threadId: first.threadId },
        },
      ];
    });
    const visited = lastVisit.get(caller.person.id);
    lastVisit.set(caller.person.id, now);
    return {
      generatedAt: iso(now),
      lastVisitAt: visited === undefined ? null : iso(visited),
      needsYou: { state: "ok", ...page(own, 0, TODAY_BLOCK_MAX), notMeasured: [] },
      shipped: notConfigured("work_tracker"),
      working: { state: "ok", items: working.slice(0, TODAY_BLOCK_MAX), notMeasured: [] },
      stuck: notConfigured("work_tracker"),
      health: notConfigured("health"),
    };
  };

  const seedNeeds = (machineId: string, count: number, kind = "thread_question") => {
    const machine = machines.get(machineId);
    if (!machine) throw new RelayError("not_found", "No such machine.");
    const list = needs.get(machine.personId) ?? [];
    needs.set(machine.personId, list);
    const at = iso(Date.now());
    for (let index = 0; index < count; index += 1) {
      const item: NeedsItem = {
        seq: nextNeedsSeq++,
        id: randomId("n"),
        kind,
        title: `Seeded item ${list.length + 1}`,
        createdAt: at,
        ...(kind.startsWith("thread_")
          ? { deepLink: { environmentId: machine.facts.environmentId, threadId: "th_seeded" } }
          : {}),
      };
      list.push(item);
      if (kind === "mention") {
        emit("mention", "MentionEvent", { at, item: needsView(item) }, machine.personId);
      }
    }
    emit("needs.changed", "NeedsChangedEvent", { at, count: list.length }, machine.personId);
  };

  const bumpCapabilities = () => {
    capabilitiesRevision += 1;
    emit(
      "capabilities.changed",
      "CapabilitiesChangedEvent",
      { at: iso(Date.now()), capabilitiesVersion: capabilitiesVersion() },
      null,
    );
    return capabilitiesVersion();
  };

  const publishBundle = (bundleSha: string) =>
    emit("bundle.changed", "BundleChangedEvent", { at: iso(Date.now()), bundleSha }, null);

  const removeStaff = (login: string) => {
    const person = peopleByLogin.get(login);
    if (!person || person.removed) throw new RelayError("not_found", "No such person.");
    person.removed = true;
    for (const machine of machines.values())
      if (machine.personId === person.id && machine.revokedAt === null) revokeMachine(machine);
    closeStreams((stream) => stream.personId === person.id);
    emit("staff.removed", "StaffRemovedEvent", { at: iso(Date.now()), personId: person.id }, null);
  };

  const sendJson = (
    response: NodeHttp.ServerResponse,
    status: number,
    schema: SchemaName,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const problem = spec.check(schema, body);
    if (problem !== null) {
      log(`fake relay: invalid ${schema} response: ${problem}`);
      sendError(response, new RelayError("internal", "The fake relay built an invalid response."));
      return;
    }
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };

  const sendError = (response: NodeHttp.ServerResponse, error: RelayError) => {
    const body = {
      error: {
        code: error.code,
        message: error.message,
        retryable: false,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
    response.writeHead(error.status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const openStream = (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    caller: Caller,
  ) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    const stream: Stream = { personId: caller.person.id, machineId: caller.machine.id, response };
    // Without Last-Event-ID the stream is live only. With one, replay what is still within reach (the last
    // 1000 events and the retention window); beyond that, or for an unknown id, send one reset.
    const lastEventId = headerValue(request, "Last-Event-ID");
    if (lastEventId !== undefined) {
      pruneEvents();
      const oldest = events[0]?.id ?? nextEventId;
      const last = /^[0-9]{1,15}$/.test(lastEventId) ? Number(lastEventId) : Number.NaN;
      if (last >= oldest - 1 && last < nextEventId) {
        for (const event of events) {
          if (event.id > last && (event.personId === null || event.personId === stream.personId)) {
            writeEvent(stream, event);
          }
        }
      } else {
        sendOnly(stream, "reset", "ResetEvent", { at: iso(Date.now()) });
      }
    }
    streams.add(stream);
    const comment = setInterval(
      () => response.write(": keep-alive\n\n"),
      options.sseCommentMs ?? 25_000,
    );
    comment.unref();
    const forget = () => {
      clearInterval(comment);
      streams.delete(stream);
    };
    request.on("close", forget);
    response.on("close", forget);
  };

  const handleRelay = async (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    route: string,
    query: URLSearchParams,
  ) => {
    const method = request.method ?? "GET";
    const body = await readBody(request);

    if (method === "GET" && route === "/capabilities") {
      // Only a call without Authorization gets the public document; a failing token is refused.
      if (headerValue(request, "Authorization") === undefined) {
        sendJson(response, 200, "Capabilities", publicCapabilities(), {
          etag: `"${capabilitiesVersion()}"`,
        });
        return;
      }
      const caller = authenticate(request, body);
      sendJson(
        response,
        200,
        "Capabilities",
        {
          ...publicCapabilities(),
          me: {
            id: caller.person.id,
            login: caller.person.login,
            role: caller.person.role,
            machineId: caller.machine.id,
          },
          sections: [
            { id: "today", kind: "today", version: 1, flags: [] },
            { id: "needs", kind: "needs", version: 1, flags: ["mentions"] },
            { id: "machines", kind: "machines", version: 1, flags: ["revoke"] },
          ],
          mcpTools: [
            {
              name: "needs_list",
              description: "List the caller's needs-you items.",
              role: "limited_staff",
            },
          ],
          adapters: [
            { role: "work_tracker", kind: "none" },
            { role: "staff_directory", kind: "none" },
            { role: "knowledge", kind: "none" },
            { role: "health", kind: "none" },
          ],
        },
        { etag: `"${capabilitiesVersion()}"` },
      );
      return;
    }

    if (method === "POST" && route === "/enroll/start") {
      const start = parseJson(body, "EnrolStartRequest") as {
        publicKey: string;
        machine: MachineFacts;
      };
      const publicKey = publicKeyFromBase64(start.publicKey);
      if (!publicKey)
        throw new RelayError("malformed", "publicKey is not an Ed25519 key.", {
          field: "publicKey",
        });
      enrolmentSignature(request, publicKey, body);
      const pairing: Pairing = {
        id: randomId("pr"),
        code: confirmCode(),
        publicKey,
        machine: start.machine,
        networkIdentity:
          identityHeader === undefined ? null : (headerValue(request, identityHeader) ?? null),
        state: "pending",
        expiresAt: Date.now() + PAIRING_MS,
        wrongCodes: 0,
      };
      pairings.set(pairing.id, pairing);
      const host = headerValue(request, "Host") ?? "localhost";
      const reply = {
        pairingId: pairing.id,
        confirmCode: pairing.code,
        browserUrl: `http://${host}/enroll?pairing=${pairing.id}`,
        expiresAt: iso(pairing.expiresAt),
        state: "pending",
        retryAfterMs,
      };
      if (autoApprove) confirmPairing(pairing.id, pairing.code, defaultPerson);
      sendJson(response, 200, "EnrolStartResponse", reply);
      return;
    }

    if (method === "POST" && route === "/enroll/poll") {
      const poll = parseJson(body, "EnrolPollRequest") as { pairingId: string };
      const pairing = pairingById(poll.pairingId);
      enrolmentSignature(request, pairing.publicKey, body);
      const reply: Record<string, unknown> = {
        pairingId: pairing.id,
        state: pairing.state,
        expiresAt: iso(pairing.expiresAt),
        retryAfterMs:
          pairing.state === "pending" || pairing.state === "awaiting_approval" ? retryAfterMs : 0,
      };
      if (pairing.state === "approved") {
        reply.machineId = pairing.machineId;
        if (pairing.token !== undefined) {
          reply.token = pairing.token;
          delete pairing.token;
        }
      }
      if (pairing.state === "refused" || pairing.state === "expired") reply.reason = pairing.reason;
      sendJson(response, 200, "EnrolPollResponse", reply);
      return;
    }

    const caller = authenticate(request, body);

    if (method === "GET" && route === "/machines") {
      const { offset, limit } = pageParams(query);
      const all = visibleMachines(caller).map((machine) => machineView(machine, caller));
      sendJson(response, 200, "MachinesPage", page(all, offset, limit));
      return;
    }

    const machinePath = /^\/machines\/([^/]+)$/.exec(route);
    if (method === "DELETE" && machinePath?.[1]) {
      const target = ID_PATTERN.test(machinePath[1]) ? machines.get(machinePath[1]) : undefined;
      if (!target) throw new RelayError("not_found", "No such machine.");
      if (target.revokedAt === null) {
        if (target.personId !== caller.person.id && caller.person.role !== "founder") {
          throw new RelayError("forbidden", "Only the machine's owner or a founder may revoke it.");
        }
        revokeMachine(target);
      }
      response.writeHead(204);
      response.end();
      return;
    }

    if (method === "POST" && route === "/facts") {
      const facts = parseJson(body, "FactsRequest") as {
        machine: MachineFacts;
        activity: ReadonlyArray<ActivityFact>;
      };
      if (facts.machine.environmentId !== caller.machine.facts.environmentId) {
        throw new RelayError(
          "forbidden",
          "machine.environmentId is not this machine's environment.",
          {
            field: "machine.environmentId",
          },
        );
      }
      caller.machine.facts = facts.machine;
      caller.machine.sessions = facts.activity;
      caller.machine.lastHeardAt = Date.now();
      sendJson(response, 200, "FactsResponse", {
        acceptedAt: iso(caller.machine.lastHeardAt),
        heartbeatSeconds: HEARTBEAT_SECONDS,
        capabilitiesVersion: capabilitiesVersion(),
      });
      return;
    }

    if (method === "GET" && route === "/today") {
      sendJson(response, 200, "Today", today(caller));
      return;
    }

    if (method === "GET" && route === "/needs") {
      const { offset, limit } = pageParams(query);
      const ordered = byUrgency(needs.get(caller.person.id) ?? []).map(needsView);
      sendJson(response, 200, "NeedsPage", page(ordered, offset, limit));
      return;
    }

    if (method === "GET" && route === "/events") {
      openStream(request, response, caller);
      return;
    }

    throw new RelayError("not_found", `No ${method} ${route} in relay v1.`);
  };

  const handleControl = async (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    route: string,
  ) => {
    const body = await readBody(request);
    let input: Record<string, unknown> = {};
    if (body.length > 0) {
      try {
        input = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        throw new RelayError("malformed", "The control body is not JSON.");
      }
    }
    const reply = (value: Record<string, unknown>) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const pairingAction = /^\/pairings\/([^/]+)\/(confirm|approve|refuse|expire)$/.exec(route);
    if (request.method === "POST" && pairingAction?.[1] && pairingAction[2]) {
      const pairingId = pairingAction[1];
      const action = pairingAction[2];
      const state =
        action === "confirm"
          ? confirmPairing(pairingId, String(input.code ?? ""), input.person as PersonInput)
          : action === "approve"
            ? approvePairing(pairingId)
            : action === "refuse"
              ? refusePairing(pairingId, input.reason as Refusal)
              : expirePairing(pairingId);
      reply({ state });
      return;
    }
    if (request.method === "POST" && route === "/needs") {
      seedNeeds(
        String(input.machineId),
        Number(input.count ?? 1),
        (input.kind as string | undefined) ?? undefined,
      );
      reply({});
      return;
    }
    if (request.method === "POST" && route === "/capabilities/bump") {
      reply({ capabilitiesVersion: bumpCapabilities() });
      return;
    }
    if (request.method === "POST" && route === "/bundle") {
      publishBundle(String(input.bundleSha));
      reply({});
      return;
    }
    if (request.method === "POST" && route === "/staff/remove") {
      removeStaff(String(input.login));
      reply({});
      return;
    }
    throw new RelayError("not_found", `No control call ${request.method} ${route}.`);
  };

  const server = NodeHttp.createServer((request, response) => {
    const target = request.url ?? "/";
    const queryAt = target.indexOf("?");
    const path = queryAt === -1 ? target : target.slice(0, queryAt);
    const query = new URLSearchParams(queryAt === -1 ? "" : target.slice(queryAt + 1));
    const handled = path.startsWith(`${PREFIX}/`)
      ? handleRelay(request, response, path.slice(PREFIX.length), query)
      : path.startsWith(`${CONTROL_PREFIX}/`)
        ? handleControl(request, response, path.slice(CONTROL_PREFIX.length))
        : Promise.reject(new RelayError("not_found", "Not a relay v1 path."));
    handled.catch((cause: unknown) => {
      const error =
        cause instanceof RelayError
          ? cause
          : new RelayError("internal", "The fake relay failed.", undefined);
      if (!(cause instanceof RelayError)) log(`fake relay: ${String(cause)}`);
      else log(`fake relay: ${request.method} ${target} -> ${error.code}`);
      if (response.headersSent) response.end();
      else sendError(response, error);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address() as NodeNet.AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `http://${host}:${address.port}`;

  return {
    url,
    baseUrl: `${url}${PREFIX}`,
    close: () =>
      new Promise<void>((resolve) => {
        closeStreams(() => true);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    confirmPairing,
    approvePairing,
    refusePairing,
    expirePairing,
    approve: (code, person = defaultPerson) => {
      const pairing = pairingByCode(code);
      const state = confirmPairing(pairing.id, code, person);
      return state === "awaiting_approval" ? approvePairing(pairing.id) : state;
    },
    refuse: (code, reason) => refusePairing(pairingByCode(code).id, reason),
    seedNeeds,
    bumpCapabilities,
    publishBundle,
    removeStaff,
  };
};
