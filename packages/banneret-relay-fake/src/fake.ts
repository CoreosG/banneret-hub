// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - a plain node:http test double with no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import {
  BANNERET_AGENT_TOOLS,
  foldLease,
  type LeaseComment,
  type LeaseFoldResult,
} from "@t3tools/contracts/leaseProtocol";

import type {
  ChatChange,
  ChatConversation,
  ChatCreate,
  ChatEdit,
  ChatMessage,
  ChatPatch,
  ChatPost,
  ChatRead,
  PoolConfig,
  PoolHostFacts,
  PoolNextRequest,
  PoolSandboxRequest,
  PoolStateUpdate,
  PoolCurrent,
} from "@t3tools/contracts";
import { createPool } from "./pool.ts";
import { openAlarmStore, type Alarm } from "./alarms.ts";
import { publicKeyFromBase64, verify } from "./signing.ts";
import { loadSpec, type SchemaName } from "./spec.ts";
import { checkStagePlan, type StagePlan } from "./stage-plan.ts";

/**
 * A fake /relay/v1 relay: a test double and conformance target. By default everything lives in
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
  | "stale_offer"
  | "pool_limit_reached"
  | "level_not_offered"
  | "malformed"
  | "rate_limited"
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

/** Checks that a public origin is a bare http(s) origin and returns it normalised; throws otherwise. */
export const parsePublicOrigin = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`publicOrigin must be an origin such as https://host:8443, got "${value}"`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(
      `publicOrigin must be a scheme, a host and an optional port with no path, got "${value}"`,
    );
  }
  return parsed.origin;
};

interface HealthSource {
  readonly id: string;
  readonly kind: string;
  readonly secret?: string;
  readonly measurement?: {
    label: string;
    state: "good" | "warning" | "bad" | "not_measured";
    observedAt: string | null;
    summary?: string;
  };
}

export interface FakeRelayOptions {
  readonly chat?: boolean;
  readonly pool?: PoolConfig;
  readonly healthSources?: readonly HealthSource[];
  readonly criticalRecipients?: readonly string[];
  readonly dashboards?: ReadonlyArray<{ id: string; title: string; url: string; group?: string }>;
  readonly board?: { staleSeconds: number; expirySeconds: number };
  readonly alarmDatabase?: string;
  /** 0 (the default) picks a free port. */
  readonly port?: number;
  readonly host?: string;
  /**
   * The origin clients reach the fake at when it sits behind a proxy, such as `https://host:port` from Tailscale
   * Serve. Used for the absolute `browserUrl`. A scheme, a host and an optional port, no path. Default: the
   * request's Host header over http.
   */
  readonly publicOrigin?: string;
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
  readonly poolHostId?: string;
  readonly os: string;
  readonly hubVersion: string;
  readonly policyFingerprint: string | null;
  readonly sandbox: { readonly enabled: boolean; readonly image: string | null };
}

interface UsageFact {
  readonly provider: string;
  readonly window: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

/**
 * README, Team: the team state of each session a heartbeat carries. A stopped session is left out; a wait whose
 * process is not running is a finished turn, so it is idle. `since` stays while the state stays.
 */
const nextTeamStates = (
  before: ReadonlyMap<string, TeamState>,
  facts: ReadonlyArray<{
    readonly sessionId: string;
    readonly state: string;
    readonly waiting?: string;
    readonly processRunning?: boolean;
  }>,
): ReadonlyMap<string, TeamState> => {
  const now = Date.now();
  const next = new Map<string, TeamState>();
  for (const fact of facts) {
    if (fact.state === "stopped") continue;
    const state =
      fact.state === "working"
        ? "working"
        : fact.state === "waiting" &&
            fact.processRunning === true &&
            (fact.waiting === "permission" || fact.waiting === "question")
          ? "waiting"
          : "idle";
    const previous = before.get(fact.sessionId);
    next.set(fact.sessionId, {
      state,
      since: previous?.state === state ? previous.since : now,
    });
  }
  return next;
};

interface ActivityFact {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly threadId: string;
  readonly branch?: string;
  readonly projectKey?: string;
  readonly taskId?: string;
  readonly provider: string;
  readonly state: "working" | "waiting" | "idle" | "stopped";
  readonly waiting?: "permission" | "question" | "input";
  readonly processRunning?: boolean;
  readonly lastSeenAt: string;
}

/** A session's state in the team file (README, Team), and since when it has held it. */
interface TeamState {
  readonly state: "working" | "waiting" | "idle";
  readonly since: number;
}

interface Pairing {
  readonly poolHost: boolean;
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
}

interface Machine {
  readonly poolHost: boolean;
  readonly id: string;
  readonly personId: string;
  readonly publicKey: NodeCrypto.KeyObject;
  /** The latest token's hash; null until the first poll after approval mints one. */
  tokenHash: string | null;
  /** Set by the first call authenticated with the token; ends re-issue on poll. */
  tokenUsed: boolean;
  readonly enrolledAt: number;
  facts: MachineFacts;
  sessions: ReadonlyArray<ActivityFact>;
  /** By session id: the team state of each session the latest heartbeat carried (stopped ones left out). */
  teamStates: ReadonlyMap<string, TeamState>;
  usage: ReadonlyArray<UsageFact>;
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

interface RepositoryItem {
  readonly projectKey: string;
  readonly name: string;
  readonly url: string;
}

/** One head a person has had. `files` maps a kind (needs, health, ...) to `sha256:<hex>`. */
interface SnapshotHeadRecord {
  readonly files: Readonly<Record<string, string>>;
  /** The exact bytes served; its hash is the ETag. */
  readonly body: Buffer;
  /** `sha256:<hex>` of `body`, unquoted. */
  readonly etag: string;
  /** When a newer head replaced this one; null while it is the current head. */
  replacedAt: number | null;
}

/** A seeded board task. The lease clock is `lastSignalAt`; state is computed from it on every read. */
interface PersonView {
  readonly id: string;
  readonly login: string;
}

/** The sign-off record of a seeded task (README, Checked). Validity is decided when it is seeded. */
interface CheckedRecord {
  readonly by: PersonView;
  readonly at: number;
  readonly valid: boolean;
  readonly ignoredReason?: string;
}

interface FeedRecord {
  readonly id: string;
  readonly type: string;
  readonly at: number;
  readonly author: PersonView | null;
  readonly importance: string;
  readonly summary: string;
  readonly taskId: string | null;
  readonly status: string | null;
  /** Only on `released` entries (README, Lease protocol). */
  readonly release?: {
    readonly reason: string;
    readonly freeToContinue: boolean;
    readonly reasonText?: string;
    readonly note?: string;
  };
}

/** The tracker issue behind a task, when a test seeds one: the lease comes from the fold, not from `holder`. */
interface TrackerIssue {
  comments: Array<LeaseComment>;
  assignees: Array<string>;
  labels: Array<string>;
  /** How many counted releases already made a feed entry. */
  releasesFed: number;
}

interface GraveyardRecord {
  readonly taskId: string;
  readonly title: string;
  readonly cause: string;
  readonly ruledAt: number;
  readonly by: PersonView | null;
}

/** What the relay's configured stage plan currently gives it (README, Map and the stage plan). */
type StagePlanSource =
  | {
      readonly kind: "ok";
      readonly plan: StagePlan;
      readonly statuses: ReadonlyMap<string, string>;
    }
  | {
      readonly kind: "broken";
      readonly reason: "malformed" | "unreachable";
      readonly detail: string;
      readonly since: number;
    };

interface PrApprovals {
  required: number;
  have: number;
  codeOwners: { required: boolean; owners: string[]; satisfiedBy?: PersonView[] };
  lastPushApproval: boolean;
  lastPushSatisfied: boolean;
  stale: boolean;
}
const noApprovalRule: PrApprovals = {
  required: 0,
  have: 0,
  codeOwners: { required: false, owners: [] },
  lastPushApproval: false,
  lastPushSatisfied: true,
  stale: false,
};
interface LinkedPr {
  readonly baseBranch: string;
  readonly approvals: PrApprovals | null;
  readonly author: string;
  readonly candidates: string[];
  readonly approvalOnly: boolean;
  readonly number: number;
  readonly state: string;
  readonly checks: string | null;
  readonly mergedAt: number | null;
}

/** One configured board: every `filter` board in `dev` mode. */
interface BoardConfig {
  readonly id: string;
  readonly title: string;
}

interface BoardTask {
  readonly id: string;
  readonly title: string;
  /** The id of the board that shows the task. */
  readonly board: string;
  column: string;
  status: string;
  holder: { readonly id: string; readonly login: string } | null;
  /** Linked pull requests, oldest first. `mergedAt` is internal: it feeds Today's Shipped block. */
  prs: Array<LinkedPr>;
  readonly openedAt: number;
  closedAt: number | null;
  preview: { readonly state: string; readonly url?: string } | null;
  checked: CheckedRecord | null;
  readonly forcedLeaseState: "paused" | "conflict" | null;
  readonly tracker: TrackerIssue | null;
  readonly branch: string | null;
  readonly projectKey: string | null;
  readonly restsOn: ReadonlyArray<string>;
  since: number;
  lastSignalAt: number;
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
  readonly current?: PoolCurrent;
  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    current?: PoolCurrent,
  ) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
    if (current) this.current = current;
  }
}

const STATUS: Record<ErrorCode, number> = {
  malformed: 400,
  stale_offer: 409,
  pool_limit_reached: 409,
  level_not_offered: 403,
  rate_limited: 429,
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
/** README, Team: sessions of a machine silent this long leave the team file. */
const TEAM_FORGET_MS = 24 * 60 * 60 * 1000;
const TEAM_PEOPLE_MAX = 500;
const TEAM_SESSIONS_MAX = 100;
const HEARTBEAT_SECONDS = 30;
const EVENT_LOG_SIZE = 1000;
const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const TODAY_BLOCK_MAX = 20;
const COUNTER_MAX = 9223372036854775807n;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COUNTER_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const COUNTER_WINDOW = 256;

const BOARD_COLUMNS = [
  { id: "free", title: "Free" },
  { id: "taken", title: "Taken" },
  { id: "validating", title: "Validating" },
  { id: "stuck", title: "Stuck" },
  { id: "shipped", title: "Shipped" },
] as const;
/** The fake's boards until a `board/seed` names others (README, "Board and leases"). */
const DEFAULT_BOARDS: ReadonlyArray<BoardConfig> = [
  { id: "platform", title: "Platform" },
  { id: "ops", title: "Ops" },
];
const STATUS_WHY: Readonly<Record<string, string>> = {
  ruled_dead: "The issue was closed as not planned.",
  checked: "A sign-off role holder checked it after the merge.",
  sent_back: "The work was sent back after review or merge.",
  needs_you: "Something on it needs a person.",
  blocked: "It waits on a task that is blocked.",
  built: "The pull request merged and nobody has checked it yet.",
  planned: "Open and none of the other statuses apply.",
};
// Snapshot retention (README, Snapshot): a file stays readable while one of the person's last 16 heads names it, or
// a head replaced less than 10 minutes ago does.
const SNAPSHOT_KEEP_HEADS = 16;
const SNAPSHOT_KEEP_MS = 10 * 60 * 1000;
const SNAPSHOT_MACHINES_MAX = 500;
const SNAPSHOT_REPOSITORIES_MAX = 1000;
const SNAPSHOT_HASH_PATTERN = /^[0-9a-f]{64}$/;
// The Timestamp schema: RFC 3339 in UTC, ending in Z.
const SENT_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const spec = loadSpec();

const randomId = (prefix: string) =>
  `${prefix}_${NodeCrypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const confirmCode = () =>
  Array.from(NodeCrypto.randomBytes(8), (byte) => BASE32[byte % 32]).join("");
const sha256Hex = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
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
  chat_ask: 1,
  pull_request: 2,
  pr_approval: 2,
  waiting_for_approver: 2,
  promotion: 2,
  founder_question: 2,
  health: 2,
  mention: 3,
  agent_message: 3,
  persona_ask: 3,
  other: 5,
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
  /** Adds `count` repositories (`example-org/repo-N`) to the company list, in recording order. */
  readonly seedRepositories: (count: number) => void;
  /** Changes the capabilities document and sends `capabilities.changed`. */
  readonly bumpCapabilities: () => string;
  readonly publishBundle: (bundleSha: string) => void;
  /** Removes a person: their machines are revoked and `staff.removed` goes to everyone. */
  readonly removeStaff: (login: string) => void;
}

export const startFakeRelay = async (options: FakeRelayOptions = {}): Promise<FakeRelay> => {
  const publicOrigin =
    options.publicOrigin === undefined ? undefined : parsePublicOrigin(options.publicOrigin);
  if (options.pool && spec.check("PoolConfig", options.pool))
    throw new Error("Invalid pool configuration.");
  const board = options.board ?? { staleSeconds: 21600, expirySeconds: 86400 };
  if (spec.check("LeaseClocks", board) || board.expirySeconds <= board.staleSeconds)
    throw new Error("Invalid lease clocks.");
  const leaseStaleMs = board.staleSeconds * 1000;
  const leaseExpiryMs = board.expirySeconds * 1000;
  const dashboards = options.dashboards ?? [];
  if (
    spec.check("Dashboards", dashboards) ||
    new Set(dashboards.map((d) => d.id)).size !== dashboards.length ||
    dashboards.some((d) => !URL.canParse(d.url) || new URL(d.url).protocol !== "https:")
  )
    throw new Error("Invalid dashboard.");
  const sources = new Map((options.healthSources ?? []).map((source) => [source.id, source]));
  if (sources.size !== (options.healthSources?.length ?? 0) || sources.size > 20)
    throw new Error("Invalid health sources.");
  for (const source of sources.values()) {
    if (
      spec.check("Id", source.id) ||
      !/^[a-z][a-z0-9_]{0,31}$/.test(source.kind) ||
      (source.secret !== undefined && (typeof source.secret !== "string" || !source.secret))
    )
      throw new Error("Invalid health source.");
  }
  if (
    options.criticalRecipients !== undefined &&
    (!Array.isArray(options.criticalRecipients) ||
      options.criticalRecipients.some((id) => spec.check("Id", id)))
  )
    throw new Error("Invalid critical recipients.");
  const measurements = [...sources.values()]
    .filter((source) => source.measurement || !source.secret)
    .map((source) => ({
      ...(source.measurement ?? { label: source.id, state: "not_measured", observedAt: null }),
      source: source.id,
      id: source.id,
      kind: source.kind,
    }));
  if (spec.check("HealthBlock", { state: "ok", items: measurements, alarms: [], notMeasured: [] }))
    throw new Error("Invalid health measurement.");
  const alarms = sources.size ? openAlarmStore(options.alarmDatabase ?? ":memory:") : undefined;
  const rates = new Map<string, { until: number; count: number }>();
  const sourceIds = [...sources.keys()];
  const activeAlarms = () => alarms?.active(sourceIds) ?? [];
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
  const pool = createPool(options.pool, (code, message, current) => {
    throw new RelayError(code, message, undefined, current);
  });
  const poolHosts = new Set(options.pool?.hosts.map((h) => h.id));
  const pairings = new Map<string, Pairing>();
  const machines = new Map<string, Machine>();
  const machinesByToken = new Map<string, Machine>();
  const needs = new Map<string, NeedsItem[]>();
  const events: RelayEvent[] = [];
  const streams = new Set<Stream>();
  const eventClock = options.eventClock ?? (() => Date.now());
  let nextEventId = 1;
  let nextNeedsSeq = 1;
  const repositories: RepositoryItem[] = [];
  /** Snapshot files, stored once by the hash of their bytes. Holding a file grants nothing: reads check the heads. */
  const snapshotFiles = new Map<string, Buffer>();
  /** Per person, oldest head first. The last one is current. */
  const snapshotHeads = new Map<string, SnapshotHeadRecord[]>();
  /** Board tasks in seeding order. Relay-wide. */
  let boardTasks: BoardTask[] = [];
  let boards: ReadonlyArray<BoardConfig> = DEFAULT_BOARDS;
  // The fake has a work tracker once a board is seeded; until then Today's Shipped block is not configured.
  let boardSeeded = false;
  /** Derived entries, newest first. Relay-wide. */
  let feedRecords: FeedRecord[] = [];
  let graveyardRecords: GraveyardRecord[] = [];
  /** The configured stage plan; null means none is configured, so the map is not advertised. */
  let stagePlan: StagePlanSource | null = null;
  const holderIds = new Map<string, string>();
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
      // A lease seeded for this login before it enrolled already carries an id; keep it.
      id: holderIds.get(input.login) ?? randomId("p"),
      login: input.login,
      role: input.role ?? "limited_staff",
      networkIdentity: input.networkIdentity ?? null,
      removed: false,
    };
    people.set(person.id, person);
    peopleByLogin.set(person.login, person);
    return person;
  };

  personFor({ login: "cy-example", role: "limited_staff" });

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
    refreshAllHeads();
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
        machine.poolHost !== pairing.poolHost ||
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
    const machine: Machine = {
      id: randomId("m"),
      personId: person.id,
      poolHost: pairing.poolHost,
      publicKey: pairing.publicKey,
      tokenHash: null,
      tokenUsed: false,
      enrolledAt: Date.now(),
      facts: pairing.machine,
      sessions: [],
      teamStates: new Map(),
      usage: [],
      lastHeardAt: null,
      counters: [],
      revokedAt: null,
    };
    machines.set(machine.id, machine);
    refreshAllHeads();
    pairing.state = "approved";
    pairing.machineId = machine.id;
  };

  /**
   * Re-issue on poll: until a token is used, every poll after approval mints a fresh one and the one
   * before it stops working. Nothing is minted for a revoked machine or a removed person.
   */
  const reissueToken = (machine: Machine): string | undefined => {
    if (machine.tokenUsed || machine.revokedAt !== null) return undefined;
    if (people.get(machine.personId)?.removed !== false) return undefined;
    const token = `rdt_${NodeCrypto.randomBytes(32).toString("base64url")}`;
    if (machine.tokenHash !== null) machinesByToken.delete(machine.tokenHash);
    machine.tokenHash = hashToken(token);
    machinesByToken.set(machine.tokenHash, machine);
    return token;
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
    if (pairing.poolHost && person.role !== "founder") {
      pairing.state = "refused";
      pairing.reason = "declined";
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

  const authenticate = (
    request: NodeHttp.IncomingMessage,
    body: Buffer,
    hostCall = false,
  ): Caller => {
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
    if (machine.poolHost !== hostCall)
      throw new RelayError("forbidden", "Wrong credential for this route.");
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
    machine.tokenUsed = true;
    return { machine, person };
  };

  const publicCapabilities = () => ({
    displayName: options.displayName ?? "Example Company",
    iconUrl: null,
    enrolment: { start: "/relay/v1/enroll/start", browser: "/enroll" },
  });

  const machineView = (machine: Machine, viewer: Person) => {
    const owner = people.get(machine.personId);
    const revoked = machine.revokedAt !== null;
    return {
      id: machine.id,
      environmentId: machine.facts.environmentId,
      ownerId: machine.personId,
      ownerLogin: owner?.login ?? "unknown",
      label: machine.facts.label,
      kind: machine.facts.kind,
      ...(machine.facts.poolHostId ? { poolHostId: machine.facts.poolHostId } : {}),
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
      revocable: !revoked && (machine.personId === viewer.id || viewer.role === "founder"),
      ...(machine.revokedAt === null ? {} : { revokedAt: iso(machine.revokedAt) }),
    };
  };

  const liveMachines = () =>
    [...machines.values()]
      .filter((machine) => !machine.poolHost && machine.revokedAt === null)
      .toSorted(
        (a, b) =>
          (b.lastHeardAt ?? -1) - (a.lastHeardAt ?? -1) ||
          b.enrolledAt - a.enrolledAt ||
          a.id.localeCompare(b.id),
      );

  // Every enrolled person sees every live machine; revoked ones only their owner and founders, after the live ones.
  const visibleMachines = (viewer: Person) => [
    ...liveMachines(),
    ...[...machines.values()]
      .filter(
        (machine) =>
          !machine.poolHost &&
          machine.revokedAt !== null &&
          (machine.personId === viewer.id || viewer.role === "founder"),
      )
      .toSorted((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0) || a.id.localeCompare(b.id)),
  ];

  const notConfigured = (source: string) => ({
    state: "not_measured",
    items: [],
    notMeasured: [{ source, reason: "not_configured", since: iso(startedAt) }],
  });

  const outstanding = (pr: LinkedPr) =>
    pr.state === "open" &&
    pr.approvals !== null &&
    (pr.approvals.have < pr.approvals.required ||
      (pr.approvals.codeOwners.required && !pr.approvals.codeOwners.satisfiedBy?.length) ||
      (pr.approvals.lastPushApproval && !pr.approvals.lastPushSatisfied));
  const candidates = (pr: LinkedPr) =>
    outstanding(pr)
      ? pr.candidates.flatMap((login) => {
          const person = peopleByLogin.get(login);
          return person && !person.removed && person.login !== pr.author
            ? [{ id: person.id, login: person.login }]
            : [];
        })
      : [];
  const approvalNeeds = (viewer: Person) =>
    boardTasks.flatMap((task) =>
      task.prs.flatMap((pr) => {
        if (
          !outstanding(pr) ||
          !pr.approvalOnly ||
          pr.checks === "failing" ||
          pr.checks === "pending"
        )
          return [];
        const author = pr.author === viewer.login;
        if (!author && !candidates(pr).some((p) => p.id === viewer.id)) return [];
        const kind = author ? "waiting_for_approver" : "pr_approval";
        return [
          {
            seq: pr.number,
            id: sha256Hex(Buffer.from(JSON.stringify([kind, task.id, pr.number]))),
            kind,
            title: `#${pr.number} ${task.title}`.slice(0, 300),
            url: prUrl(pr.number),
            createdAt: iso(task.openedAt),
          },
        ];
      }),
    );
  const personalNeeds = (person: Person) => {
    const recipient = options.criticalRecipients?.includes(person.id) ?? person.role === "founder";
    const critical = recipient ? activeAlarms().filter((a) => a.severity === "critical") : [];
    return byUrgency([
      ...(needs.get(person.id) ?? []),
      ...approvalNeeds(person),
      ...(person.role === "founder" ? pool.needs().map((need, seq) => ({ ...need, seq })) : []),
      ...critical.map((a, seq) => ({
        seq,
        id: sha256Hex(Buffer.from(JSON.stringify([a.sourceId, a.id, a.firedAt]))),
        kind: "health",
        title: a.title,
        createdAt: a.firedAt,
        ...(a.url ? { url: a.url } : {}),
      })),
    ]).map(needsView);
  };

  const approvalViews = () =>
    new Map(
      [...people.values()]
        .filter((person) => !person.removed)
        .map((person) => [person, JSON.stringify(approvalNeeds(person))] as const),
    );
  const notifyApprovalChanges = (before: Map<Person, string>) => {
    for (const [person, previous] of before) {
      if (previous !== JSON.stringify(approvalNeeds(person))) {
        emit(
          "needs.changed",
          "NeedsChangedEvent",
          { at: iso(Date.now()), count: personalNeeds(person).length },
          person.id,
        );
      }
    }
  };

  // The needs-you, working, stuck and health blocks of Today for one person. Reads no visit state.
  const todayBlocks = (person: Person) => {
    const now = Date.now();
    const own = personalNeeds(person);
    const working = liveMachines().flatMap((machine) => {
      const owner = people.get(machine.personId);
      const live = machine.sessions.filter((session) => session.state !== "stopped");
      const first = live[0];
      if (!owner || !first) return [];
      const heard = machine.lastHeardAt !== null && now - machine.lastHeardAt <= NOT_HEARD_FROM_MS;
      return [
        {
          person: { id: owner.id, login: owner.login },
          ...(first.branch === undefined ? {} : { branch: first.branch }),
          sessions: live.length,
          state: heard ? first.state : "not_heard_from",
          deepLink: { environmentId: machine.facts.environmentId, threadId: first.threadId },
        },
      ];
    });
    return {
      needsYou: { state: "ok", ...page(own, 0, TODAY_BLOCK_MAX), notMeasured: [] },
      working: { state: "ok", items: working.slice(0, TODAY_BLOCK_MAX), notMeasured: [] },
      stuck: notConfigured("work_tracker"),
      health:
        sources.size === 0
          ? undefined
          : {
              state: "ok",
              items: measurements,
              alarms: activeAlarms(),
              notMeasured: [],
            },
    };
  };

  // README, Shipped: one item per merged pull request since the last visit (all of them before a first visit),
  // newest first. Each carries its own `pr` and the task's `ref`, so a client never joins Shipped to the board.
  const shippedBlock = (since: number | null) => {
    const items = boardTasks
      .flatMap((task, index) =>
        task.prs.flatMap((pr) =>
          pr.mergedAt === null || (since !== null && pr.mergedAt <= since)
            ? []
            : [{ task, index, pr, mergedAt: pr.mergedAt }],
        ),
      )
      .toSorted((a, b) => b.mergedAt - a.mergedAt)
      .slice(0, TODAY_BLOCK_MAX)
      .map(({ task, index, pr, mergedAt }) => {
        const ref = taskRefView(task, index).ref;
        return {
          task: { id: task.id, title: task.title, url: ref.url },
          pr: { number: pr.number, url: prUrl(pr.number), repo: ref.scope },
          ref,
          summary: `${task.title} merged.`.slice(0, 300),
          mergedAt: iso(mergedAt),
          live: "no_deploy",
        };
      });
    return { state: "ok", items, notMeasured: [] };
  };

  const today = (caller: Caller, since: number | null) => {
    const now = Date.now();
    const blocks = todayBlocks(caller.person);
    return {
      generatedAt: iso(now),
      needsYou: blocks.needsYou,
      shipped: boardSeeded ? shippedBlock(since) : notConfigured("work_tracker"),
      working: blocks.working,
      stuck: blocks.stuck,
      health: blocks.health,
    };
  };

  // Board and leases (README, Board and leases). State is computed from the lease age on every read.
  const leaseState = (task: BoardTask, now: number): string => {
    if (task.forcedLeaseState !== null) return task.forcedLeaseState;
    const age = now - task.lastSignalAt;
    return age >= leaseExpiryMs ? "expired" : age >= leaseStaleMs ? "stale" : "active";
  };

  const personRefFor = (login: string): PersonView => {
    const known = peopleByLogin.get(login);
    const id =
      known?.id ??
      holderIds.get(login) ??
      (() => {
        const created = randomId("p");
        holderIds.set(login, created);
        return created;
      })();
    return { id, login };
  };

  const taskRefView = (
    task: {
      readonly id: string;
      readonly title: string;
      readonly openedAt: number;
      readonly closedAt: number | null;
    },
    index: number,
  ) => ({
    id: task.id,
    title: task.title,
    ref: {
      tracker: "github",
      scope: "example-org/example-app",
      key: String(index + 1),
      url: `https://github.com/example-org/example-app/issues/${index + 1}`,
    },
    openedAt: iso(task.openedAt),
    closedAt: task.closedAt === null ? null : iso(task.closedAt),
  });
  const prUrl = (number: number) => `https://github.com/example-org/example-app/pull/${number}`;

  // No board card: the task comes from the plan ref. The id is derived from the ref, so it is stable and opaque.
  // The fake cannot read an issue, so the title is the plan item's title, the issue counts as opened when the fake
  // started, and it is open.
  const refOnlyTask = (ref: NonNullable<StagePlan["items"][number]["task"]>, title: string) => ({
    id: `ref_${sha256Hex(Buffer.from(JSON.stringify([ref.tracker, ref.host ?? null, ref.scope, ref.key]))).slice(0, 24)}`,
    title,
    ref: {
      tracker: ref.tracker,
      ...(ref.host === undefined ? {} : { host: ref.host }),
      scope: ref.scope,
      key: ref.key,
      url: `https://${ref.host ?? "github.com"}/${ref.scope}/issues/${ref.key}`,
    },
    openedAt: iso(startedAt),
    closedAt: null,
  });

  // README, Lease protocol. Founders are the enrolled people holding the founder role.
  const foldTracker = (tracker: TrackerIssue, now: number): LeaseFoldResult =>
    foldLease({
      comments: tracker.comments,
      assignees: tracker.assignees,
      labels: tracker.labels,
      founders: [...peopleByLogin.values()]
        .filter((person) => person.role === "founder" && person.removed !== true)
        .map((person) => person.login),
      now: iso(now),
    });

  // The lease a card shows. A tracker-backed task folds its comments; `active` then ages from the holder's latest
  // comment or heartbeat, while `conflict` and `incomplete` never age.
  const leaseOf = (task: BoardTask, now: number) => {
    if (task.tracker === null) {
      return task.holder === null
        ? undefined
        : {
            holder: task.holder,
            state: leaseState(task, now),
            since: iso(task.since),
            lastSignalAt: iso(task.lastSignalAt),
            staleAt: iso(task.lastSignalAt + leaseStaleMs),
            expiresAt: iso(task.lastSignalAt + leaseExpiryMs),
          };
    }
    const folded = foldTracker(task.tracker, now).lease;
    if (folded === null) return undefined;
    const holder = folded.holder;
    const latestComment = task.tracker.comments
      .filter(
        (comment) =>
          comment.author !== null && comment.author.toLowerCase() === holder.toLowerCase(),
      )
      .reduce((latest, comment) => Math.max(latest, Date.parse(comment.createdAt)), 0);
    const since = folded.since === null ? task.since : Date.parse(folded.since);
    const lastSignalAt = Math.max(latestComment, task.lastSignalAt, since);
    const age = now - lastSignalAt;
    return {
      holder: personRefFor(holder),
      state:
        folded.state !== "active"
          ? folded.state
          : age >= leaseExpiryMs
            ? "expired"
            : age >= leaseStaleMs
              ? "stale"
              : "active",
      since: iso(since),
      lastSignalAt: iso(lastSignalAt),
      staleAt: iso(lastSignalAt + leaseStaleMs),
      expiresAt: iso(lastSignalAt + leaseExpiryMs),
    };
  };

  const lastReleaseOf = (task: BoardTask, now: number) => {
    if (task.tracker === null) return undefined;
    const last = foldTracker(task.tracker, now).lastRelease;
    return last === null ? undefined : { ...last, by: personRefFor(last.by) };
  };

  // README, "Free and Taken": the tracker's assignees, or the seeded holder for a task without
  // tracker fields (a take assigns the taker).
  const assigneesOf = (task: BoardTask) =>
    task.tracker !== null
      ? task.tracker.assignees.map(personRefFor)
      : task.holder === null
        ? []
        : [task.holder];

  const cardView = (task: BoardTask, index: number, now: number, viewer?: Person) => {
    const lease = leaseOf(task, now);
    const lastRelease = lastReleaseOf(task, now);
    // A held task that is not active is in Stuck, never Free; a held task never sits in Free.
    const held = lease !== undefined;
    const column =
      held && lease.state !== "active" && lease.state !== "paused"
        ? "stuck"
        : task.column === "free" &&
            (held || (task.tracker !== null && task.tracker.assignees.length > 0))
          ? "taken"
          : task.column;
    const status = held && lease.state === "conflict" ? "needs_you" : task.status;
    const statusWhy =
      held && lease.state === "conflict"
        ? "Two people claim this task."
        : held && lease.state === "incomplete"
          ? `A take or release by ${lease.holder.login} did not finish on the tracker.`
          : held && (lease.state === "stale" || lease.state === "expired")
            ? `${lease.holder.login} has been quiet, so the claim is ${lease.state}.`
            : (STATUS_WHY[status] ?? STATUS_WHY.planned ?? "");
    return {
      task: taskRefView(task, index),
      kind: "issue",
      column,
      status,
      statusWhy,
      ...(lease === undefined ? {} : { lease }),
      ...(lastRelease === undefined ? {} : { lastRelease }),
      assignees: assigneesOf(task),
      prs: task.prs.map((pr) => {
        const canApprove = candidates(pr);
        return {
          number: pr.number,
          url: prUrl(pr.number),
          state: pr.state,
          baseBranch: pr.baseBranch,
          approvals: pr.approvals,
          canApprove,
          youCanApprove: canApprove.some((p) => p.id === viewer?.id),
          ...(pr.checks === null ? {} : { checks: { state: pr.checks } }),
        };
      }),
      restsOn: task.restsOn,
    };
  };

  // One file per board and the index with each board's counts, after every column rule. Task ids and keys stay
  // relay-wide: a card's index is its place in the whole seed, whichever board shows it.
  const boardFiles = (viewer: Person) => {
    const now = Date.now();
    const cards = boardTasks.map((task, index) => ({
      board: task.board,
      card: cardView(task, index, now, viewer),
    }));
    return boards.map((config) => {
      const own = cards.filter((entry) => entry.board === config.id).map((entry) => entry.card);
      const counts: Record<string, number> = {};
      for (const column of BOARD_COLUMNS) counts[column.id] = 0;
      for (const card of own) counts[card.column] = (counts[card.column] ?? 0) + 1;
      return {
        entry: {
          id: config.id,
          title: config.title,
          mode: "dev",
          source: { kind: "filter" },
          counts,
        },
        file: { state: "ok", notMeasured: [], columns: BOARD_COLUMNS, cards: own },
      };
    });
  };

  // README, Map and the stage plan.
  const BLOCKING = new Set(["needs_you", "sent_back", "ruled_dead", "blocked"]);
  const STATUS_WORD: Readonly<Record<string, string>> = {
    needs_you: "needs you",
    sent_back: "was sent back",
    ruled_dead: "was ruled dead",
    blocked: "is blocked",
  };
  // README, Map: a card's `blocked` comes from the board's own rests-on row; the map applies its own `restsOn`, so
  // the item starts from the status the card has without that row. A seeded `blocked` is treated the same way.
  const unblocked = (status: string, merged: boolean) =>
    status === "blocked" ? (merged ? "built" : "planned") : status;
  const mapView = () => {
    if (stagePlan === null)
      throw new Error("the map is built only when a stage plan is configured");
    if (stagePlan.kind === "broken") {
      return {
        state: "not_measured",
        notMeasured: [
          {
            source: "stage_plan",
            reason: stagePlan.reason,
            since: iso(stagePlan.since),
            detail: stagePlan.detail.slice(0, 240),
          },
        ],
        stages: [],
        items: [],
        counters: { byStatus: {}, byStage: {} },
      };
    }
    const { plan, statuses } = stagePlan;
    const now = Date.now();
    // The join: the plan's task names tracker, host, scope and key; a board card is found by its ref.
    const cards = boardTasks.map((task, index) => ({
      view: cardView(task, index, now),
      ref: taskRefView(task, index),
    }));
    const findCard = (item: StagePlan["items"][number]) =>
      item.task === undefined
        ? undefined
        : cards.find(
            ({ ref }) =>
              ref.ref.tracker === item.task?.tracker &&
              ref.ref.scope === item.task.scope &&
              ref.ref.key === item.task.key &&
              // The fake's board has no host, so a plan that names one matches nothing.
              item.task.host === undefined,
          );
    const planned = new Map(plan.items.map((item) => [item.id, item] as const));
    type Resolved = { status: string; statusWhy: string; blockedBy: ReadonlyArray<string> };
    const resolved = new Map<string, Resolved>();
    const resolve = (id: string): Resolved => {
      const known = resolved.get(id);
      if (known !== undefined) return known;
      const item = planned.get(id);
      if (item === undefined) throw new Error(`unknown item ${id}`);
      const card = findCard(item);
      const ownOf = (status: string) => ({
        status,
        statusWhy: STATUS_WHY[status] ?? STATUS_WHY.planned ?? "",
      });
      let own: { status: string; statusWhy: string } =
        card !== undefined
          ? card.view.status === "blocked"
            ? ownOf(
                unblocked(
                  "blocked",
                  card.view.prs.some((pr) => pr.state === "merged"),
                ),
              )
            : { status: card.view.status, statusWhy: card.view.statusWhy }
          : item.task !== undefined
            ? { status: "planned", statusWhy: "The tracker issue is not on the board yet." }
            : ownOf(unblocked(statuses.get(item.id) ?? "planned", false));
      // Direct blockers only: each dependency's own final status, never the root cause behind it.
      const blockedBy = [...new Set(item.restsOn ?? [])].filter((target) =>
        BLOCKING.has(resolve(target).status),
      );
      const first = blockedBy[0];
      if (first !== undefined && (own.status === "built" || own.status === "planned")) {
        own = {
          status: "blocked",
          statusWhy:
            `Blocked by "${planned.get(first)?.title ?? first}", which ${STATUS_WORD[resolve(first).status] ?? "is blocked"}.`.slice(
              0,
              240,
            ),
        };
      }
      const result = { ...own, blockedBy };
      resolved.set(id, result);
      return result;
    };
    const stages = plan.stages.toSorted((a, b) => a.order - b.order);
    const stageRank = new Map(stages.map((stage, index) => [stage.id, index] as const));
    const items = plan.items
      .map((item, position) => ({ item, position }))
      .toSorted(
        (a, b) =>
          (stageRank.get(a.item.stageId) ?? 0) - (stageRank.get(b.item.stageId) ?? 0) ||
          a.position - b.position,
      )
      .map(({ item }) => {
        const { status, statusWhy, blockedBy } = resolve(item.id);
        const card = findCard(item);
        return {
          id: item.id,
          stageId: item.stageId,
          title: item.title,
          status,
          statusWhy,
          // README, Map: an item with a plan `task` always carries `task`, card or no card.
          ...(item.task === undefined
            ? {}
            : { task: card?.ref ?? refOnlyTask(item.task, item.title) }),
          restsOn: [...(item.restsOn ?? [])],
          blockedBy: [...blockedBy],
        };
      });
    const byStatus: Record<string, number> = {};
    const byStage: Record<string, Record<string, number>> = Object.fromEntries(
      stages.map((stage) => [stage.id, {}]),
    );
    for (const item of items) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      const stage = byStage[item.stageId] ?? {};
      stage[item.status] = (stage[item.status] ?? 0) + 1;
      byStage[item.stageId] = stage;
    }
    return {
      state: "ok",
      notMeasured: [],
      stages: stages.map(({ id, title, order }) => ({ id, title, order })),
      items,
      counters: { byStatus, byStage },
    };
  };

  // README, Task: the card plus the preview and the sign-off record.
  const taskView = (task: BoardTask, index: number, viewer: Person) => ({
    ...cardView(task, index, Date.now(), viewer),
    ...(task.preview === null ? {} : { preview: task.preview }),
    ...(task.checked === null
      ? {}
      : {
          checked: {
            by: task.checked.by,
            at: iso(task.checked.at),
            valid: task.checked.valid,
            ...(task.checked.ignoredReason === undefined
              ? {}
              : { ignoredReason: task.checked.ignoredReason }),
          },
        }),
  });

  // README, Feed and graveyard. Entries are stored newest first and paged by offset, like the other lists.
  const feedEntryView = (record: FeedRecord) => {
    const index = boardTasks.findIndex((candidate) => candidate.id === record.taskId);
    const task = index < 0 ? undefined : boardTasks[index];
    return {
      id: record.id,
      type: record.type,
      at: iso(record.at),
      ...(record.author === null ? {} : { author: record.author }),
      importance: record.importance,
      summary: record.summary,
      ...(task === undefined
        ? {}
        : {
            link: taskRefView(task, index).ref.url,
            task: taskRefView(task, index),
          }),
      ...(record.status === null ? {} : { status: record.status }),
      ...record.release,
    };
  };
  const graveyardEntryView = (record: GraveyardRecord) => {
    const index = boardTasks.findIndex((candidate) => candidate.id === record.taskId);
    const seeded = index < 0 ? undefined : boardTasks[index];
    const task = taskRefView(
      seeded ?? {
        id: record.taskId,
        title: record.title,
        openedAt: record.ruledAt - 24 * 3_600_000,
        closedAt: record.ruledAt,
      },
      index < 0 ? 99 : index,
    );
    return {
      task,
      cause: record.cause,
      ruledAt: iso(record.ruledAt),
      ...(record.by === null ? {} : { by: record.by }),
      link: task.ref.url,
    };
  };
  const SNAPSHOT_FEED_MAX = 100;
  const feedFile = () => ({
    entries: feedRecords.slice(0, SNAPSHOT_FEED_MAX).map(feedEntryView),
    nextCursor: feedRecords.length > SNAPSHOT_FEED_MAX ? encodeCursor(SNAPSHOT_FEED_MAX) : null,
  });
  const graveyardFile = () => ({
    entries: graveyardRecords.slice(0, SNAPSHOT_FEED_MAX).map(graveyardEntryView),
    nextCursor:
      graveyardRecords.length > SNAPSHOT_FEED_MAX ? encodeCursor(SNAPSHOT_FEED_MAX) : null,
  });

  // The board task a fact without a taskId works on, by its branch and projectKey, as for lease heartbeats.
  const taskForBranch = (fact: ActivityFact) =>
    fact.branch === undefined
      ? undefined
      : boardTasks.find(
          (task) =>
            task.branch === fact.branch &&
            (task.projectKey === null || task.projectKey === fact.projectKey),
        );

  // README, Team: every staff member and their live sessions. `since` moves only when a state changes.
  const teamView = () => {
    const now = Date.now();
    const staff = [...people.values()]
      .filter((person) => !person.removed)
      .toSorted((a, b) => a.login.localeCompare(b.login));
    return {
      people: staff.slice(0, TEAM_PEOPLE_MAX).map((person) => {
        const sessions = liveMachines()
          .filter(
            (machine) =>
              machine.personId === person.id &&
              machine.lastHeardAt !== null &&
              now - machine.lastHeardAt <= TEAM_FORGET_MS,
          )
          .flatMap((machine) => {
            const heardAt = machine.lastHeardAt ?? now;
            const heard = now - heardAt <= NOT_HEARD_FROM_MS;
            return machine.sessions.flatMap((fact) => {
              const team = machine.teamStates.get(fact.sessionId);
              if (team === undefined) return [];
              const taskId = fact.taskId ?? taskForBranch(fact)?.id;
              return [
                {
                  fact,
                  view: {
                    id: fact.sessionId,
                    machineId: machine.id,
                    provider: fact.provider,
                    state: heard ? team.state : "not_heard_from",
                    ...(heard && team.state === "waiting" && fact.waiting !== undefined
                      ? { waiting: fact.waiting as "permission" | "question" }
                      : {}),
                    ...(taskId === undefined ? {} : { taskId }),
                    since: iso(heard ? team.since : heardAt),
                  },
                },
              ];
            });
          })
          .slice(0, TEAM_SESSIONS_MAX);
        const listed = new Set(sessions.map(({ fact }) => fact.sessionId));
        return {
          id: person.id,
          login: person.login,
          role: person.role,
          sessions: sessions.map(({ fact, view }) => {
            const parent = fact.parentSessionId;
            return parent !== undefined && listed.has(parent) && parent !== fact.sessionId
              ? { ...view, parentId: parent }
              : view;
          }),
        };
      }),
    };
  };

  // Snapshot (README, Snapshot). A head is rebuilt on every change and on every read, so a served head is always
  // current. Files are content-addressed and shared, but a read checks the caller's own retained heads.
  const buildSnapshotFiles = (person: Person): Record<string, string> => {
    const blocks = todayBlocks(person);
    const machineList = visibleMachines(person).map((machine) => machineView(machine, person));
    const entries: ReadonlyArray<readonly [string, SchemaName, unknown]> = [
      ["needs", "SnapshotNeeds", blocks.needsYou],
      ...(blocks.health ? [["health", "HealthBlock", blocks.health] as const] : []),
      ["work", "SnapshotWork", { working: blocks.working, stuck: blocks.stuck }],
      [
        "machines",
        "SnapshotMachines",
        {
          items: machineList.slice(0, SNAPSHOT_MACHINES_MAX),
          truncated: machineList.length > SNAPSHOT_MACHINES_MAX,
        },
      ],
      [
        "repositories",
        "SnapshotRepositories",
        {
          items: repositories.slice(0, SNAPSHOT_REPOSITORIES_MAX),
          truncated: repositories.length > SNAPSHOT_REPOSITORIES_MAX,
        },
      ],
      ...(() => {
        const files = boardFiles(person);
        return [
          ["boards", "SnapshotBoards", { boards: files.map((board) => board.entry) }],
          ...files.map(
            (board) => [`board.${board.entry.id}`, "SnapshotBoard", board.file] as const,
          ),
        ] as ReadonlyArray<readonly [string, SchemaName, unknown]>;
      })(),
      ...(stagePlan === null
        ? []
        : [["map", "SnapshotMap", mapView()] as readonly [string, SchemaName, unknown]]),
      ["feed", "FeedPage", feedFile()],
      ["graveyard", "GraveyardPage", graveyardFile()],
      ["team", "SnapshotTeam", teamView()],
    ];
    const refs: Record<string, string> = {};
    for (const [kind, schema, value] of entries) {
      const problem = spec.check(schema, value);
      if (problem !== null)
        throw new Error(`fake relay built an invalid snapshot ${kind}: ${problem}`);
      const bytes = Buffer.from(JSON.stringify(value), "utf8");
      const hex = sha256Hex(bytes);
      // Stored before any head names it.
      snapshotFiles.set(hex, bytes);
      refs[kind] = `sha256:${hex}`;
    }
    return refs;
  };

  // Heads that still count for retention, and the removal of files nobody's retained heads name any more.
  const pruneSnapshots = () => {
    const now = Date.now();
    const named = new Set<string>();
    for (const [personId, heads] of snapshotHeads) {
      const person = people.get(personId);
      if (!person || person.removed) {
        snapshotHeads.delete(personId);
        continue;
      }
      const kept = heads.filter(
        (head, index) =>
          index >= heads.length - SNAPSHOT_KEEP_HEADS ||
          head.replacedAt === null ||
          now - head.replacedAt < SNAPSHOT_KEEP_MS,
      );
      snapshotHeads.set(personId, kept);
      for (const head of kept) for (const ref of Object.values(head.files)) named.add(ref.slice(7));
    }
    for (const hex of snapshotFiles.keys()) if (!named.has(hex)) snapshotFiles.delete(hex);
  };

  const refreshHead = (person: Person): SnapshotHeadRecord => {
    const refs = buildSnapshotFiles(person);
    const heads = snapshotHeads.get(person.id) ?? [];
    const current = heads.at(-1);
    if (
      current !== undefined &&
      Object.keys(refs).length === Object.keys(current.files).length &&
      Object.entries(refs).every(([kind, ref]) => current.files[kind] === ref)
    ) {
      pruneSnapshots();
      return current;
    }
    const now = Date.now();
    const head = {
      generatedAt: iso(now),
      files: refs,
    };
    const problem = spec.check("SnapshotHead", head);
    if (problem !== null) throw new Error(`fake relay built an invalid snapshot head: ${problem}`);
    const body = Buffer.from(JSON.stringify(head), "utf8");
    if (current !== undefined) current.replacedAt = now;
    const record: SnapshotHeadRecord = {
      files: refs,
      body,
      etag: `sha256:${sha256Hex(body)}`,
      replacedAt: null,
    };
    snapshotHeads.set(person.id, [...heads, record]);
    pruneSnapshots();
    return record;
  };

  // Rebuilds the head of every person who has one: any change to facts, needs, machines or repositories can move
  // a head, and the work and machines files are relay-wide.
  const refreshAllHeads = () => {
    for (const personId of snapshotHeads.keys()) {
      const person = people.get(personId);
      if (person && !person.removed) refreshHead(person);
    }
    pruneSnapshots();
  };

  // A file is readable only while one of the caller's retained heads names it.
  const readableSnapshotFile = (person: Person, hex: string): Buffer | undefined => {
    pruneSnapshots();
    const ref = `sha256:${hex}`;
    const named = (snapshotHeads.get(person.id) ?? []).some((head) =>
      Object.values(head.files).includes(ref),
    );
    return named ? snapshotFiles.get(hex) : undefined;
  };

  // `If-None-Match`: one or more comma-separated tags; any equal to the current tag matches.
  const matchesEtag = (header: string | undefined, etag: string) =>
    header !== undefined && header.split(",").some((tag) => tag.trim() === etag);

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
    refreshAllHeads();
    const owner = people.get(machine.personId);
    if (owner)
      emit(
        "needs.changed",
        "NeedsChangedEvent",
        { at, count: personalNeeds(owner).length },
        machine.personId,
      );
  };

  const seedRepositories = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const name = `example-org/repo-${repositories.length + 1}`;
      repositories.push({
        projectKey: `sha256:${NodeCrypto.createHash("sha256").update(`github.com/${name}`).digest("hex")}`,
        name,
        url: `https://github.com/${name}`,
      });
    }
    refreshAllHeads();
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

  // The fake starts with an empty change log. Only channel data is enabled in F0.
  type Channel = {
    id: string;
    name: string;
    purpose: string;
    private: boolean;
    agents: ChatConversation["agents"];
    archived: boolean;
    members: Set<string>;
    creator: string;
  };
  const channels = new Map<string, Channel>();
  const messages = new Map<string, ChatMessage>();
  const postKeys = new Map<string, string>();
  const cursors = new Map<string, number>();
  const cursorKey = (personId: string, id: string, root = "") =>
    JSON.stringify([personId, id, root]);
  type MessageChange = Extract<ChatChange, { message: ChatMessage }>;
  type StoredChange =
    | Exclude<ChatChange, MessageChange>
    | { seq: number; kind: MessageChange["kind"]; messageId: string };
  const changes: { channel: Channel; person?: string; value: StoredChange }[] = [];
  let chatSeq = 0;
  if (options.chat)
    channels.set("c_general", {
      id: "c_general",
      name: "general",
      purpose: "",
      private: false,
      agents: "allowed",
      archived: false,
      members: new Set(),
      creator: "",
    });
  const visible = (c: Channel, p: string) => !c.private || c.members.has(p);
  const chatChange = (channel: Channel, value: ChatChange, person?: string) => {
    if (value.kind === "read.moved") {
      const { threadRootId } = value.read;
      const index = changes.findIndex(
        (row) =>
          row.person === person &&
          row.channel === channel &&
          row.value.kind === "read.moved" &&
          row.value.read.threadRootId === threadRootId,
      );
      if (index >= 0) changes.splice(index, 1);
    }
    const stored =
      "message" in value
        ? { kind: value.kind, seq: value.seq, messageId: value.message.id }
        : value;
    changes.push({ channel, value: stored, ...(person ? { person } : {}) });
    const event =
      Buffer.byteLength(JSON.stringify(value)) <= 8192
        ? { seq: value.seq, change: value }
        : { seq: value.seq };
    for (const stream of streams) {
      if (
        (person === undefined || person === stream.personId) &&
        visible(channel, stream.personId)
      ) {
        stream.response.write(`event: chat.changed\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }
  };
  const channelView = (channel: Channel, person: Person): ChatConversation => {
    const roots = [...messages.values()].filter(
      (m) => m.conversationId === channel.id && !m.threadRootId,
    );
    const readSeq = cursors.get(cursorKey(person.id, channel.id)) ?? 0;
    const unread = roots.filter(
      (m) =>
        !m.deleted && m.seq > readSeq && (m.author.kind === "system" || m.author.id !== person.id),
    );
    return {
      id: channel.id,
      kind: "channel",
      name: channel.name,
      purpose: channel.purpose,
      private: channel.private,
      agents: channel.agents,
      archived: channel.archived,
      memberCount: { people: channel.members.size, agents: 0 },
      lastSeq: roots.at(-1)?.seq ?? 0,
      me: {
        member: channel.members.has(person.id),
        notify: "mentions",
        muted: false,
        readSeq,
        unread: unread.length,
        mentions: unread.filter((m) => m.mentions.some((t) => t.id === person.id)).length,
      },
    };
  };

  const removeStaff = (login: string) => {
    const person = peopleByLogin.get(login);
    if (!person || person.removed) throw new RelayError("not_found", "No such person.");
    person.removed = true;
    snapshotHeads.delete(person.id);
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
      ...(error.current && { current: error.current }),
      error: {
        code: error.code,
        message: error.message,
        retryable: error.status === 429,
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
    if (method === "POST" && route.startsWith("/hooks/")) {
      const source = sources.get(route.slice("/hooks/".length));
      if (!source?.secret || !alarms) throw new RelayError("not_found", "Unknown webhook.");
      const now = Date.now();
      let rate = rates.get(source.id);
      if (!rate || rate.until <= now) {
        rate = { until: now + 60_000, count: 0 };
        rates.set(source.id, rate);
      }
      if (++rate.count > 60) {
        response.setHeader("retry-after", Math.ceil((rate.until - now) / 1000));
        throw new RelayError("rate_limited", "Too many webhook requests.");
      }
      const body = await readBody(request);
      const timestamp = headerValue(request, "X-Alarm-Timestamp") ?? "";
      const signature = headerValue(request, "X-Alarm-Signature") ?? "";
      const sent = Number(timestamp) * 1000;
      const received = Date.now();
      if (!/^\d{1,12}$/.test(timestamp) || Math.abs(received - sent) > 300_000)
        throw new RelayError("clock_skew", "Webhook timestamp outside the replay window.");
      const mac = NodeCrypto.createHmac("sha256", source.secret)
        .update(timestamp + ".")
        .update(body)
        .digest();
      if (
        !/^[0-9a-f]{64}$/.test(signature) ||
        !NodeCrypto.timingSafeEqual(mac, Buffer.from(signature, "hex"))
      )
        throw new RelayError("bad_signature", "Invalid webhook signature.");
      const alarm = parseJson(body, "Alarm") as Alarm;
      if (
        alarm.sourceId !== source.id ||
        (alarm.resolvedAt && Date.parse(alarm.resolvedAt) < Date.parse(alarm.firedAt))
      )
        throw new RelayError("malformed", "Invalid alarm source or times.");
      if (!alarms.record(alarm, signature, sent + 300_000, received))
        throw new RelayError("counter_reused", "Webhook already received.");
      refreshAllHeads();
      for (const person of people.values()) {
        if (
          !person.removed &&
          (options.criticalRecipients?.includes(person.id) ?? person.role === "founder")
        )
          emit(
            "needs.changed",
            "NeedsChangedEvent",
            { at: iso(received), count: personalNeeds(person).length },
            person.id,
          );
      }
      response.writeHead(204).end();
      return;
    }
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
          ...(options.chat
            ? {
                chat: {
                  maxTextBytes: 16384,
                  editWindowSeconds: 0,
                  rate: {
                    postsPerMinute: 10,
                    postsPerHour: 120,
                    openAsks: 5,
                    hopCap: 4,
                    pairPerMinute: 20,
                  },
                  retentionDays: { channels: 0, dms: 0 },
                },
              }
            : {}),
          dashboards,
          sections: [
            ...(options.chat
              ? [
                  {
                    id: "chat",
                    kind: "chat",
                    version: 1,
                    flags: ["channels", "private_channels", "threads"],
                  },
                ]
              : []),
            ...(options.pool?.enabled ? [{ id: "pool", kind: "pool", version: 1, flags: [] }] : []),
            ...(sources.size ? [{ id: "health", kind: "health", version: 1, flags: [] }] : []),
            { id: "today", kind: "today", version: 1, flags: [] },
            { id: "needs", kind: "needs", version: 1, flags: ["mentions"] },
            { id: "machines", kind: "machines", version: 1, flags: ["revoke"] },
            {
              id: "board",
              kind: "board",
              version: 2,
              flags: ["leases", "checked", "boards"],
              params: board,
            },
            ...(stagePlan === null
              ? []
              : [{ id: "map", kind: "map", version: 1, flags: ["rests_on"] }]),
            { id: "feed", kind: "feed", version: 1, flags: ["graveyard"] },
            { id: "task", kind: "task", version: 1, flags: [] },
            { id: "team", kind: "team", version: 1, flags: [] },
          ],
          // The Hub's agent toolkit, enabled for everyone; the Hub keeps its own descriptions.
          mcpTools: BANNERET_AGENT_TOOLS.map((name) => ({
            name,
            description: "A Banneret Hub agent tool.",
            role: "limited_staff",
          })),
          adapters: [
            { role: "work_tracker", kind: "none" },
            { role: "staff_directory", kind: "none" },
            { role: "knowledge", kind: "none" },
          ],
          snapshot: { version: 1, head: `${PREFIX}/snapshot/head` },
        },
        { etag: `"${capabilitiesVersion()}"` },
      );
      return;
    }

    const isPool = route === "/pool" || route.startsWith("/pool/");
    if (isPool && !options.pool?.enabled) throw new RelayError("not_found", "Pool is disabled.");
    if (isPool && query.size)
      throw new RelayError("malformed", "Pool calls take no query parameters.");
    const hostEnroll = route.startsWith("/pool/hosts/enroll/");
    if (method === "POST" && (route === "/enroll/start" || route === "/pool/hosts/enroll/start")) {
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
      if (hostEnroll && !poolHosts.has(start.machine.environmentId))
        throw new RelayError("level_not_offered", "Unknown pool host.");
      const pairing: Pairing = {
        poolHost: hostEnroll,
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
      const origin = publicOrigin ?? `http://${headerValue(request, "Host") ?? "localhost"}`;
      const reply = {
        pairingId: pairing.id,
        confirmCode: pairing.code,
        browserUrl: `${origin}/enroll?pairing=${pairing.id}`,
        expiresAt: iso(pairing.expiresAt),
        state: "pending",
        retryAfterMs,
      };
      if (autoApprove && !hostEnroll) confirmPairing(pairing.id, pairing.code, defaultPerson);
      sendJson(response, 200, "EnrolStartResponse", reply);
      return;
    }

    if (method === "POST" && (route === "/enroll/poll" || route === "/pool/hosts/enroll/poll")) {
      const poll = parseJson(body, "EnrolPollRequest") as { pairingId: string };
      const pairing = pairingById(poll.pairingId);
      if (hostEnroll !== pairing.poolHost) throw new RelayError("not_found", "Unknown pairing.");
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
        const machine =
          pairing.machineId === undefined ? undefined : machines.get(pairing.machineId);
        const token = machine === undefined ? undefined : reissueToken(machine);
        if (token !== undefined) reply.token = token;
      }
      if (pairing.state === "refused" || pairing.state === "expired") reply.reason = pairing.reason;
      sendJson(response, 200, "EnrolPollResponse", reply);
      return;
    }

    const statePath = /^\/pool\/sandboxes\/([^/]+)\/state$/.exec(route);
    const caller = authenticate(
      request,
      body,
      isPool && (route.startsWith("/pool/hosts/") || !!statePath),
    );
    if (isPool) {
      const owner = caller.person.id;
      const host = caller.machine.facts.environmentId;
      const sandbox = /^\/pool\/sandboxes\/([^/]+)(\/extend)?$/.exec(route);
      if (method === "GET" && route === "/pool")
        return sendJson(response, 200, "PoolView", pool.list(owner));
      if (method === "POST" && route === "/pool/workspaces") {
        const { hostId } = parseJson(body, "PoolWorkspaceRequest") as { hostId: string };
        const workspace = pool.ask(owner, hostId);
        refreshAllHeads();
        return sendJson(response, 200, "PoolWorkspace", workspace);
      }
      if (method === "POST" && route === "/pool/sandboxes") {
        const input = parseJson(body, "PoolSandboxRequest") as PoolSandboxRequest;
        return sendJson(
          response,
          200,
          "PoolSandbox",
          pool.enqueue(owner, input, {
            machineId: caller.machine.id,
            ...signingHeaders(request),
            bodyBase64: body.toString("base64"),
          }),
        );
      }
      if (sandbox?.[1]) {
        if (method === "GET" && !sandbox[2])
          return sendJson(response, 200, "PoolSandbox", pool.read(owner, sandbox[1]));
        if (method === "DELETE" && !sandbox[2])
          return sendJson(response, 200, "PoolSandbox", pool.cancel(owner, sandbox[1]));
        if (method === "POST" && sandbox[2])
          return sendJson(response, 200, "PoolSandbox", pool.extend(owner, sandbox[1]));
      }
      if (method === "POST" && route === "/pool/hosts/facts") {
        const facts = parseJson(body, "PoolHostFacts") as PoolHostFacts;
        return sendJson(response, 200, "PoolPolicy", pool.report(host, facts));
      }
      if (method === "POST" && route === "/pool/hosts/next") {
        const { size } = parseJson(body, "PoolNextRequest") as PoolNextRequest;
        return sendJson(response, 200, "PoolNextResponse", pool.next(host, size));
      }
      if (method === "POST" && statePath?.[1])
        return sendJson(
          response,
          200,
          "PoolSandbox",
          pool.update(host, statePath[1], parseJson(body, "PoolStateUpdate") as PoolStateUpdate),
        );
    }

    if (options.chat && route.startsWith("/chat/")) {
      const { person } = caller;
      const [, , resource, id = "", action, memberId] = route.split("/");
      const send = (schema: SchemaName, value: unknown) => sendJson(response, 200, schema, value);
      const channelFor = (id: string) => {
        const c = channels.get(id);
        if (!c || !visible(c, person.id)) throw new RelayError("not_found", "Unknown channel.");
        return c;
      };
      const messageFor = (id: string) => {
        const m = messages.get(id);
        if (!m) throw new RelayError("not_found", "Unknown message.");
        channelFor(m.conversationId);
        return m;
      };
      const paged = <T>(rows: T[]) => {
        const { offset, limit } = pageParams(query);
        return page(rows, offset, limit);
      };
      const messageMentions = (text: string, card?: ChatMessage["card"]) => {
        if (
          Buffer.byteLength(text) > 16384 ||
          (card && Buffer.byteLength(JSON.stringify(card)) > 4096)
        )
          throw new RelayError("too_large", "Message is too large.");
        const mentions = [...new Set(text.match(/@[a-zA-Z0-9-]+/g) ?? [])].flatMap((login) => {
          const p = peopleByLogin.get(login.slice(1));
          return p ? [{ kind: "person" as const, id: p.id }] : [];
        });
        if (mentions.length > 50) throw new RelayError("malformed", "Too many mentions.");
        return mentions;
      };
      if (query.has("asHandle")) throw new RelayError("forbidden", "Unknown agent handle.");
      if (resource === "changes" && method === "GET" && !id) {
        const after = query.get("after") ?? "";
        if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
          throw new RelayError("malformed", "Expected a change sequence.");
        const { limit } = pageParams(query);
        const rows = changes.filter(
          (row) =>
            row.value.seq > Number(after) &&
            (!row.person || row.person === person.id) &&
            visible(row.channel, person.id),
        );
        const items = rows
          .slice(0, limit)
          .map(({ value }) =>
            "messageId" in value
              ? { kind: value.kind, seq: value.seq, message: messageFor(value.messageId) }
              : value,
          );
        return send("ChatChanges", {
          items,
          nextSeq: rows.length > limit ? items.at(-1)?.seq : chatSeq,
          resync: Number(after) > chatSeq,
        });
      }
      if (resource === "conversations" && !id) {
        if (method === "GET")
          return send(
            "ChatConversations",
            paged(
              [...channels.values()]
                .filter((c) => visible(c, person.id))
                .map((c) => channelView(c, person)),
            ),
          );
        if (method === "POST") {
          const input = parseJson(body, "ChatCreate") as ChatCreate;
          if (channels.size >= 500) throw new RelayError("malformed", "Channel limit reached.");
          if (input.kind !== "channel") throw new RelayError("forbidden", "DMs are disabled.");
          if ([...channels.values()].some((c) => c.name === input.name))
            throw new RelayError("malformed", "This channel name is taken.");
          const c: Channel = {
            ...input,
            purpose: input.purpose ?? "",
            id: "c_" + NodeCrypto.randomUUID(),
            members: new Set([person.id]),
            archived: false,
            creator: person.id,
          };
          channels.set(c.id, c);
          chatChange(c, {
            kind: "conversation.updated",
            seq: ++chatSeq,
            refId: c.id,
            conversationId: c.id,
          });
          return send("ChatConversation", channelView(c, person));
        }
      }
      if (resource === "conversations" && id) {
        const c = channelFor(id);
        if (!action && method === "PATCH") {
          if (c.creator !== person.id && person.role !== "founder")
            throw new RelayError(
              "forbidden",
              "Channel management requires its creator or a founder.",
            );
          const patch = parseJson(body, "ChatPatch") as ChatPatch;
          if (
            patch.name &&
            [...channels.values()].some((other) => other.id !== id && other.name === patch.name)
          )
            throw new RelayError("malformed", "This channel name is taken.");
          Object.assign(c, patch);
          chatChange(c, {
            kind: "conversation.updated",
            seq: ++chatSeq,
            refId: id,
            conversationId: id,
          });
          return send("ChatConversation", channelView(c, person));
        }
        if (action === "members") {
          if (!memberId && method === "GET")
            return send(
              "ChatMembers",
              paged(
                [...c.members].map((id) => ({ kind: "person", id, login: people.get(id)?.login })),
              ),
            );
          if (memberId && (method === "PUT" || method === "DELETE")) {
            if (memberId !== person.id && c.creator !== person.id && person.role !== "founder")
              throw new RelayError("forbidden", "Cannot change this membership.");
            if (!people.has(memberId) || people.get(memberId)?.removed)
              throw new RelayError("not_found", "Unknown person.");
            if (method === "PUT" && c.members.size >= 200 && !c.members.has(memberId))
              throw new RelayError("malformed", "Channel member limit reached.");
            if (method === "PUT") c.members.add(memberId);
            else c.members.delete(memberId);
            chatChange(c, {
              kind: method === "PUT" ? "member.added" : "member.removed",
              seq: ++chatSeq,
              conversationId: id,
              refId: memberId,
            });
            response.writeHead(204).end();
            return;
          }
        }
        if (action === "messages" && method === "GET") {
          let rows = [...messages.values()]
            .filter((m) => m.conversationId === id && !m.threadRootId)
            .reverse();
          const anchors = ["before", "after", "around"].filter((key) => query.has(key));
          if (anchors.length > 1) throw new RelayError("malformed", "Choose one message anchor.");
          const anchor = anchors[0];
          if (anchor) {
            const index = rows.findIndex((m) => m.id === query.get(anchor));
            if (index < 0) throw new RelayError("not_found", "Unknown message anchor.");
            rows =
              anchor === "before"
                ? rows.slice(index + 1)
                : anchor === "after"
                  ? rows.slice(0, index)
                  : rows.slice(Math.max(0, index - Math.floor(pageParams(query).limit / 2)));
          }
          return send("ChatMessages", paged(rows));
        }
      }
      if (resource === "threads" && id && !action && method === "GET") {
        const root = messageFor(id);
        if (root.threadRootId)
          throw new RelayError("malformed", "A reply cannot be a thread root.");
        return send("ChatThread", {
          root,
          ...paged([...messages.values()].filter((m) => m.threadRootId === id)),
        });
      }
      if (resource === "messages" && !id && method === "POST") {
        const post = parseJson(body, "ChatPost") as ChatPost;
        const c = channelFor(post.conversationId);
        if (post.asHandle || !c.members.has(person.id) || c.archived)
          throw new RelayError("forbidden", "Cannot post in this channel.");
        const key = JSON.stringify([person.id, post.key]);
        const previous = postKeys.get(key);
        if (previous) {
          const existing = messageFor(previous);
          if (existing.conversationId !== c.id)
            throw new RelayError("malformed", "Post key belongs to another channel.");
          return send("ChatMessage", existing);
        }
        const root = post.threadRootId ? messageFor(post.threadRootId) : undefined;
        if (root && (root.threadRootId || root.conversationId !== c.id))
          throw new RelayError("malformed", "Choose a root in this channel.");
        const mentions = messageMentions(post.text, post.card);
        const { key: _key, asHandle: _asHandle, ...fields } = post;
        const m: ChatMessage = {
          ...fields,
          id: "m_" + NodeCrypto.randomUUID(),
          seq: ++chatSeq,
          kind: "text",
          author: { kind: "person", id: person.id, login: person.login },
          mentions,
          replyCount: 0,
          reactions: [],
          createdAt: iso(Date.now()),
          deleted: false,
        };
        messages.set(m.id, m);
        postKeys.set(key, m.id);
        if (root)
          messages.set(root.id, {
            ...root,
            replyCount: root.replyCount + 1,
            lastReplyAt: m.createdAt,
          });
        chatChange(c, { kind: "message.created", seq: m.seq, message: m });
        return send("ChatMessage", m);
      }
      if (resource === "messages" && id && !action && (method === "PATCH" || method === "DELETE")) {
        const m = messageFor(id);
        if (
          (m.author.kind !== "person" || m.author.id !== person.id) &&
          !(method === "DELETE" && person.role === "founder")
        )
          throw new RelayError("forbidden", "Cannot change this message.");
        if (m.deleted) throw new RelayError("malformed", "This message has been deleted.");
        const input = method === "PATCH" ? (parseJson(body, "ChatEdit") as ChatEdit) : undefined;
        if (input?.asHandle) throw new RelayError("forbidden", "Unknown agent handle.");
        const { card: _card, ...base } = m;
        const edited = input
          ? {
              ...m,
              ...input,
              mentions: messageMentions(input.text, input.card ?? m.card),
              editedAt: iso(Date.now()),
            }
          : { ...base, text: "", mentions: [], deleted: true };
        messages.set(id, edited);
        chatChange(channelFor(m.conversationId), {
          kind: input ? "message.edited" : "message.deleted",
          seq: ++chatSeq,
          message: edited,
        });
        return send("ChatMessage", edited);
      }
      if (resource === "read" && !id && method === "POST") {
        const input = parseJson(body, "ChatRead") as ChatRead;
        const c = channelFor(input.conversationId);
        if (input.threadRootId) {
          const root = messageFor(input.threadRootId);
          if (root.conversationId !== c.id || root.threadRootId)
            throw new RelayError("malformed", "Unknown thread in this channel.");
        }
        if (input.seq > chatSeq)
          throw new RelayError("malformed", "Read position exceeds the current sequence.");
        const key = cursorKey(person.id, c.id, input.threadRootId);
        const previous = cursors.get(key) ?? 0;
        const read = { ...input, seq: Math.max(previous, input.seq) };
        if (read.seq > previous) {
          cursors.set(key, read.seq);
          chatChange(c, { seq: ++chatSeq, kind: "read.moved", read }, person.id);
        }
        return send("ChatRead", read);
      }
      throw new RelayError("not_found", "Unknown chat call.");
    }

    if (method === "GET" && route === "/machines") {
      const { offset, limit } = pageParams(query);
      const all = visibleMachines(caller.person).map((machine) =>
        machineView(machine, caller.person),
      );
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
        usage?: ReadonlyArray<UsageFact>;
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
      caller.machine.teamStates = nextTeamStates(caller.machine.teamStates, facts.activity);
      caller.machine.usage = facts.usage ?? [];
      caller.machine.lastHeardAt = Date.now();
      // An activity fact is a lease heartbeat only when the sending machine's owner holds the lease and the
      // session is running. Match by taskId, otherwise by branch (and projectKey, when the task has one).
      for (const fact of facts.activity) {
        if (fact.state === "stopped" && fact.processRunning !== true) continue;
        for (const task of boardTasks) {
          if (leaseOf(task, Date.now())?.holder.id !== caller.person.id) continue;
          const byTask = fact.taskId !== undefined && fact.taskId === task.id;
          const byBranch =
            fact.taskId === undefined &&
            fact.branch !== undefined &&
            task.branch === fact.branch &&
            (task.projectKey === null || task.projectKey === fact.projectKey);
          if (byTask || byBranch) task.lastSignalAt = Date.now();
        }
      }
      refreshAllHeads();
      const head = snapshotHeads.get(caller.person.id)?.at(-1);
      sendJson(response, 200, "FactsResponse", {
        acceptedAt: iso(caller.machine.lastHeardAt),
        heartbeatSeconds: HEARTBEAT_SECONDS,
        capabilitiesVersion: capabilitiesVersion(),
        ...(head === undefined ? {} : { snapshotEtag: head.etag }),
      });
      return;
    }

    if (method === "GET" && route === "/today") {
      const since = query.get("since");
      if (
        [...query.keys()].some((key) => key !== "since") ||
        query.getAll("since").length > 1 ||
        (since !== null && spec.check("Timestamp", since) !== null)
      ) {
        throw new RelayError("malformed", "Expected one optional UTC since timestamp.");
      }
      sendJson(response, 200, "Today", today(caller, since === null ? null : Date.parse(since)));
      return;
    }

    if (method === "GET" && route === "/needs") {
      const { offset, limit } = pageParams(query);
      const ordered = personalNeeds(caller.person);
      sendJson(response, 200, "NeedsPage", page(ordered, offset, limit));
      return;
    }

    if (method === "GET" && route === "/repositories") {
      const { offset, limit } = pageParams(query);
      sendJson(response, 200, "RepositoriesPage", page(repositories, offset, limit));
      return;
    }

    if (method === "GET" && (route === "/feed" || route === "/graveyard")) {
      const { offset, limit } = pageParams(query);
      const records = route === "/feed" ? feedRecords : graveyardRecords;
      const slice = records.slice(offset, offset + limit);
      const next = offset + limit < records.length ? encodeCursor(offset + limit) : null;
      if (route === "/feed") {
        sendJson(response, 200, "FeedPage", {
          entries: (slice as FeedRecord[]).map(feedEntryView),
          nextCursor: next,
        });
      } else {
        sendJson(response, 200, "GraveyardPage", {
          entries: (slice as GraveyardRecord[]).map(graveyardEntryView),
          nextCursor: next,
        });
      }
      return;
    }

    const taskPath = /^\/tasks\/([^/]+)$/.exec(route);
    if (method === "GET" && taskPath?.[1]) {
      const taskId = taskPath[1];
      const index = ID_PATTERN.test(taskId)
        ? boardTasks.findIndex((candidate) => candidate.id === taskId)
        : -1;
      const found = index < 0 ? undefined : boardTasks[index];
      if (found === undefined) throw new RelayError("not_found", "No such task.");
      sendJson(response, 200, "TaskRead", taskView(found, index, caller.person));
      return;
    }

    if (method === "GET" && route === "/events") {
      openStream(request, response, caller);
      return;
    }

    if (method === "GET" && route === "/snapshot/head") {
      const head = refreshHead(caller.person);
      const headers = { etag: `"${head.etag}"`, "cache-control": "private, no-cache" };
      if (matchesEtag(headerValue(request, "If-None-Match"), headers.etag)) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", ...headers });
      response.end(head.body);
      return;
    }

    const snapshotFile = /^\/snapshot\/files\/([^/]*)$/.exec(route);
    if (method === "GET" && snapshotFile) {
      const hex = snapshotFile[1] ?? "";
      // Malformed, unknown, expired and someone else's hash all answer the same 404, never 400.
      const bytes = SNAPSHOT_HASH_PATTERN.test(hex)
        ? readableSnapshotFile(caller.person, hex)
        : undefined;
      if (bytes === undefined) throw new RelayError("not_found", "No such snapshot file.");
      response.writeHead(200, {
        "content-type": "application/json",
        etag: `"sha256:${hex}"`,
        "cache-control": "private, max-age=31536000, immutable",
      });
      response.end(bytes);
      return;
    }

    throw new RelayError("not_found", `No ${method} ${route} in relay v1.`);
  };

  // README, Lease protocol: a seeded tracker issue. Comments get ids 1000, 1001, ... in seed order and the time of
  // the call unless the test names them.
  const seedNames = (value: unknown, name: string): Array<string> => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
      throw new RelayError("malformed", `${name} must be a list of names.`);
    return value as Array<string>;
  };
  const seedComments = (value: unknown, now: number, offset: number): Array<LeaseComment> => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new RelayError("malformed", "comments must be a list.");
    return value.map((entry: Record<string, unknown>, index) => {
      if (typeof entry.body !== "string" || typeof entry.author !== "string")
        throw new RelayError("malformed", "A comment has an author login and a body.");
      const at = entry.createdAt === undefined ? now : Date.parse(String(entry.createdAt));
      if (!Number.isFinite(at)) throw new RelayError("malformed", "createdAt must be a timestamp.");
      const edited = entry.updatedAt === undefined ? at : Date.parse(String(entry.updatedAt));
      if (!Number.isFinite(edited))
        throw new RelayError("malformed", "updatedAt must be a timestamp.");
      return {
        id: entry.id === undefined ? String(1000 + offset + index) : String(entry.id),
        author: entry.author,
        createdAt: iso(at),
        updatedAt: iso(edited),
        body: entry.body,
      };
    });
  };
  // `board/seed` may name the boards; without `boards` the fake keeps its two (Platform and Ops).
  const seedBoards = (value: unknown): ReadonlyArray<BoardConfig> => {
    if (value === undefined) return DEFAULT_BOARDS;
    if (!Array.isArray(value) || value.length < 1 || value.length > 50)
      throw new RelayError("malformed", "boards must be a list of 1 to 50 boards.");
    const seen = new Set<string>();
    return value.map((raw: Record<string, unknown>) => {
      const id = String(raw?.id ?? "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id))
        throw new RelayError("malformed", "A board id is an Id, unique among the boards.");
      seen.add(id);
      const title = String(raw.title ?? id).slice(0, 60);
      return { id, title: title === "" ? id : title };
    });
  };

  const seedTracker = (raw: Record<string, unknown>, now: number): TrackerIssue | null =>
    raw.comments === undefined && raw.assignees === undefined && raw.labels === undefined
      ? null
      : {
          comments: seedComments(raw.comments, now, 0),
          assignees: raw.assignees === undefined ? [] : seedNames(raw.assignees, "assignees"),
          labels: raw.labels === undefined ? [] : seedNames(raw.labels, "labels"),
          releasesFed: 0,
        };
  const REASON_WORDS: Readonly<Record<string, string>> = {
    done: "done",
    blocked: "blocked",
    handing_over: "handing over",
    out_of_usage: "out of usage",
    wrong_approach: "wrong approach",
    duplicate: "duplicate",
    deprioritised: "deprioritised",
    other: "other",
  };
  // Every counted release becomes one `released` feed entry, newest first; withdrawals make none.
  const feedReleases = (task: BoardTask) => {
    if (task.tracker === null) return;
    const { releases } = foldTracker(task.tracker, Date.now());
    const fresh = releases.slice(task.tracker.releasesFed);
    task.tracker.releasesFed = releases.length;
    for (const release of fresh) {
      feedRecords.unshift({
        id: randomId("f"),
        type: "released",
        at: Date.parse(release.at),
        author: personRefFor(release.by),
        importance: "normal",
        summary:
          `${release.by} released ${task.title}: ${REASON_WORDS[release.reason] ?? release.reason}` +
          (release.freeToContinue ? ", free to continue." : "."),
        taskId: task.id,
        status: task.status,
        release: {
          reason: release.reason,
          freeToContinue: release.freeToContinue,
          ...(release.reasonText === undefined ? {} : { reasonText: release.reasonText }),
          ...(release.note === undefined ? {} : { note: release.note }),
        },
      });
    }
    feedRecords.sort((left, right) => right.at - left.at);
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
    if (request.method === "POST" && route === "/repositories") {
      seedRepositories(Number(input.count ?? 1));
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
    if (request.method === "POST" && route === "/usage") {
      const machine = machines.get(String(input.machineId));
      if (!machine) throw new RelayError("not_found", "No such machine.");
      reply({ usage: machine.usage });
      return;
    }
    if (request.method === "POST" && route === "/snapshot/age") {
      const person = peopleByLogin.get(String(input.login));
      const heads = person === undefined ? undefined : snapshotHeads.get(person.id);
      if (heads === undefined)
        throw new RelayError("not_found", "That person has no snapshot head.");
      const shift = Number(input.minutes) * 60_000;
      for (const head of heads) {
        if (head.replacedAt !== null) head.replacedAt -= shift;
      }
      reply({ heads: heads.length });
      return;
    }
    if (request.method === "POST" && route === "/snapshot/rebuild") {
      const person = peopleByLogin.get(String(input.login));
      if (person === undefined || person.removed)
        throw new RelayError("not_found", "No such person.");
      const before = snapshotHeads.get(person.id)?.at(-1);
      const head = refreshHead(person);
      reply({ changed: head !== before, etag: head.etag });
      return;
    }
    if (request.method === "POST" && route === "/board/seed") {
      const list = input.tasks;
      let nextPr = 100;
      const seedTime = (value: unknown, name: string) => {
        const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
        if (!Number.isFinite(at)) throw new RelayError("malformed", `${name} must be a timestamp.`);
        return at;
      };
      const seedPrs = (value: unknown, now: number): Array<LinkedPr> => {
        if (value === undefined) return [];
        if (!Array.isArray(value)) throw new RelayError("malformed", "prs must be a list.");
        return value.map((entry: Record<string, unknown>) => {
          const state = String(entry.state ?? "open");
          const number = entry.number === undefined ? nextPr++ : Number(entry.number);
          if (!Number.isInteger(number) || number < 1)
            throw new RelayError("malformed", "A pull request number is a whole number from 1.");
          const approvals = entry.approvals === undefined ? noApprovalRule : entry.approvals;
          if (approvals !== null && spec.check("PrApprovals", approvals))
            throw new RelayError("malformed", "Invalid PR approvals.");
          return {
            baseBranch: String(entry.baseBranch ?? "main"),
            approvals: approvals as PrApprovals | null,
            candidates: Array.isArray(entry.canApprove)
              ? [...new Set(entry.canApprove.map(String))]
              : [],
            author: String(entry.author ?? ""),
            approvalOnly: entry.approvalOnly === true,
            number,
            state,
            checks: entry.checks === undefined ? null : String(entry.checks),
            mergedAt:
              state !== "merged"
                ? null
                : entry.mergedAt === undefined
                  ? now
                  : seedTime(entry.mergedAt, "mergedAt"),
          };
        });
      };
      if (!Array.isArray(list)) throw new RelayError("malformed", "tasks must be a list.");
      const seededBoards = seedBoards(input.boards);
      const boardIds = new Set(seededBoards.map((board) => board.id));
      const now = Date.now();
      const before = approvalViews();
      boardTasks = list.map((raw: Record<string, unknown>) => {
        const login = raw.holder === undefined ? null : String(raw.holder);
        const known = login === null ? undefined : peopleByLogin.get(login);
        const holderId =
          login === null
            ? null
            : (known?.id ??
              holderIds.get(login) ??
              (() => {
                const id = randomId("p");
                holderIds.set(login, id);
                return id;
              })());
        const forced = raw.leaseState === "paused" || raw.leaseState === "conflict";
        const tracker = seedTracker(raw, now);
        if (tracker !== null && (login !== null || forced))
          throw new RelayError(
            "malformed",
            "A task with comments, assignees or labels gets its lease from them; drop holder and leaseState.",
          );
        const board = raw.board === undefined ? seededBoards[0]!.id : String(raw.board);
        if (!boardIds.has(board))
          throw new RelayError("malformed", `Task ${String(raw.id)} names an unknown board.`);
        return {
          id: String(raw.id),
          title: String(raw.title ?? raw.id),
          board,
          column: String(raw.column ?? "free"),
          status: String(raw.status ?? "planned"),
          holder: login === null || holderId === null ? null : { id: holderId, login },
          prs: seedPrs(raw.prs, now),
          openedAt: raw.openedAt === undefined ? now : seedTime(raw.openedAt, "openedAt"),
          closedAt:
            raw.closedAt === undefined || raw.closedAt === null
              ? null
              : seedTime(raw.closedAt, "closedAt"),
          preview:
            typeof raw.preview === "object" && raw.preview !== null
              ? (raw.preview as { state: string; url?: string })
              : null,
          checked: null,
          forcedLeaseState: forced ? (raw.leaseState as "paused" | "conflict") : null,
          tracker,
          branch: raw.branch === undefined ? null : String(raw.branch),
          projectKey: raw.projectKey === undefined ? null : String(raw.projectKey),
          restsOn: Array.isArray(raw.restsOn) ? raw.restsOn.map(String) : [],
          since: now,
          // A tracker-backed lease is signalled by its holder's comments and heartbeats only.
          lastSignalAt: tracker === null ? now : 0,
        };
      });
      boards = seededBoards;
      for (const task of boardTasks) feedReleases(task);
      boardSeeded = true;
      refreshAllHeads();
      notifyApprovalChanges(before);
      reply({ tasks: boardTasks.length });
      return;
    }
    if (request.method === "POST" && route === "/board/tracker") {
      const task = boardTasks.find((candidate) => candidate.id === String(input.taskId));
      if (task === undefined) throw new RelayError("not_found", "No such task.");
      if (task.tracker === null)
        throw new RelayError(
          "malformed",
          "That task was seeded without comments, assignees or labels.",
        );
      const now = Date.now();
      task.tracker.comments.push(
        ...seedComments(input.comments, now, task.tracker.comments.length),
      );
      if (input.assignees !== undefined)
        task.tracker.assignees = seedNames(input.assignees, "assignees");
      if (input.labels !== undefined) task.tracker.labels = seedNames(input.labels, "labels");
      feedReleases(task);
      refreshAllHeads();
      reply({ comments: task.tracker.comments.length });
      return;
    }
    if (request.method === "POST" && route === "/map/seed") {
      // The whole body is a stage plan, or `{plan, statuses?}`. `plan: null` removes the plan.
      const wrapped = "plan" in input;
      const plan: unknown = wrapped ? input.plan : input;
      const had = stagePlan !== null;
      const statusInput = wrapped ? input.statuses : undefined;
      const statuses = new Map<string, string>();
      if (typeof statusInput === "object" && statusInput !== null) {
        for (const [id, status] of Object.entries(statusInput)) statuses.set(id, String(status));
      } else if (statusInput !== undefined) {
        throw new RelayError("malformed", "statuses must map item ids to statuses.");
      }
      if (plan === null) {
        stagePlan = null;
      } else if (
        typeof plan === "object" &&
        (plan as { unreadable?: unknown }).unreadable === true
      ) {
        stagePlan = {
          kind: "broken",
          reason: "unreachable",
          detail: "The stage plan file could not be read.",
          since: Date.now(),
        };
      } else {
        const checked = checkStagePlan(plan);
        stagePlan = checked.ok
          ? { kind: "ok", plan: checked.plan, statuses }
          : { kind: "broken", reason: "malformed", detail: checked.detail, since: Date.now() };
      }
      refreshAllHeads();
      if (had !== (stagePlan !== null)) bumpCapabilities();
      reply({
        state: stagePlan === null ? "none" : stagePlan.kind === "ok" ? "ok" : "not_measured",
      });
      return;
    }
    if (request.method === "POST" && route === "/feed/seed") {
      const count = input.count === undefined ? 3 : Number(input.count);
      if (!Number.isInteger(count) || count < 0 || count > 1000)
        throw new RelayError("malformed", "count must be a whole number from 0 to 1000.");
      const taskId = input.taskId === undefined ? null : String(input.taskId);
      const task = taskId === null ? undefined : boardTasks.find((c) => c.id === taskId);
      if (taskId !== null && task === undefined) throw new RelayError("not_found", "No such task.");
      const now = Date.now();
      feedRecords = Array.from({ length: count }, (_, index) => ({
        id: randomId("f"),
        type: String(input.type ?? "built"),
        // Newest first, one minute apart.
        at: now - index * 60_000,
        author: input.by === undefined ? null : personRefFor(String(input.by)),
        importance: String(input.importance ?? "normal"),
        summary: `Feed entry ${index + 1} of ${count}.`,
        taskId,
        status: task?.status ?? null,
        ...(String(input.type ?? "built") === "released"
          ? { release: { reason: "done", freeToContinue: false } }
          : {}),
      }));
      refreshAllHeads();
      reply({ entries: feedRecords.length });
      return;
    }
    if (request.method === "POST" && route === "/graveyard/seed") {
      const cause = typeof input.cause === "string" ? input.cause : "";
      if (cause.length < 1 || cause.length > 500)
        throw new RelayError("malformed", "cause must be 1 to 500 characters.");
      const count = input.count === undefined ? 1 : Number(input.count);
      if (!Number.isInteger(count) || count < 0 || count > 1000)
        throw new RelayError("malformed", "count must be a whole number from 0 to 1000.");
      const taskId = input.taskId === undefined ? null : String(input.taskId);
      const task = taskId === null ? undefined : boardTasks.find((c) => c.id === taskId);
      if (taskId !== null && task === undefined) throw new RelayError("not_found", "No such task.");
      const now = Date.now();
      graveyardRecords = Array.from({ length: count }, (_, index) => ({
        taskId: task?.id ?? randomId("t"),
        title: task?.title ?? `Ruled dead task ${index + 1}`,
        cause,
        ruledAt: now - index * 60_000,
        by: input.by === undefined ? null : personRefFor(String(input.by)),
      }));
      refreshAllHeads();
      reply({ entries: graveyardRecords.length });
      return;
    }
    if (request.method === "POST" && route === "/checked/seed") {
      const task = boardTasks.find((candidate) => candidate.id === String(input.taskId));
      if (task === undefined) throw new RelayError("not_found", "No such task.");
      const by = String(input.by ?? "");
      if (by === "") throw new RelayError("malformed", "by must be a person id.");
      const checker = people.get(by);
      if (checker === undefined) throw new RelayError("not_found", "No such person for by.");
      const ignoredReason =
        checker.role === "founder"
          ? undefined
          : `${checker.login} does not hold the sign-off role.`;
      const valid = ignoredReason === undefined;
      const before = approvalViews();
      task.holder = null;
      task.prs = [
        {
          number: 100 + boardTasks.indexOf(task),
          baseBranch: "main",
          approvals: noApprovalRule,
          candidates: [],
          author: "",
          approvalOnly: false,
          state: "merged",
          checks: "passing",
          mergedAt: Date.now(),
        },
      ];
      task.closedAt ??= Date.now();
      task.status = valid ? "checked" : "built";
      task.column = valid ? "shipped" : "validating";
      task.checked = {
        by: { id: checker.id, login: checker.login },
        at: Date.now(),
        valid,
        ...(ignoredReason === undefined ? {} : { ignoredReason }),
      };
      refreshAllHeads();
      notifyApprovalChanges(before);
      reply({ valid });
      return;
    }
    if (request.method === "POST" && route === "/pool/offer/expire") {
      pool.expireOffer(String(input.sandboxId));
      reply({});
      return;
    }
    if (request.method === "POST" && route === "/lease/age") {
      const task = boardTasks.find((candidate) => candidate.id === String(input.taskId));
      if (task === undefined || leaseOf(task, Date.now()) === undefined)
        throw new RelayError("not_found", "That task has no lease.");
      const shift = Number(input.hours) * 3_600_000;
      task.lastSignalAt -= shift;
      task.since -= shift;
      // A tracker-backed lease ages from its comments, so they move back too.
      if (task.tracker !== null) {
        task.tracker.comments = task.tracker.comments.map((comment) => ({
          ...comment,
          createdAt: iso(Date.parse(comment.createdAt) - shift),
          updatedAt: iso(Date.parse(comment.updatedAt) - shift),
        }));
      }
      refreshAllHeads();
      reply({});
      return;
    }
    if (request.method === "POST" && route === "/machines/age") {
      const machine = machines.get(String(input.machineId));
      if (machine === undefined || machine.lastHeardAt === null)
        throw new RelayError("not_found", "That machine has not been heard from.");
      const shift = Number(input.seconds) * 1000;
      machine.lastHeardAt -= shift;
      // The machine's whole clock moves: its sessions entered their states that much earlier too.
      machine.teamStates = new Map(
        [...machine.teamStates].map(([id, team]) => [id, { ...team, since: team.since - shift }]),
      );
      refreshAllHeads();
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
        server.close(() => {
          alarms?.close();
          resolve();
        });
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
    seedRepositories,
    bumpCapabilities,
    publishBundle,
    removeStaff,
  };
};
