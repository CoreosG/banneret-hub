// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - a plain node:http test double with no Effect runtime.
import { templates, type RoleWrite } from "./roles.ts";
import { editPresence, emptyCounts, leadSessions } from "./team.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";
import type * as NodeNet from "node:net";

import {
  BANNERET_AGENT_TOOLS,
  BANNERET_POOL_TOOLS,
  foldLease,
  parseLeaseLine,
  type LeaseComment,
  type LeaseFoldResult,
} from "@t3tools/contracts/leaseProtocol";

import type { TeamPresenceEdit, TeamPresenceValues } from "@t3tools/contracts";
import type {
  ChatAnswer,
  ChatTask,
  ChatDelivery,
  ChatHandle,
  ChatRegister,
  ChatAct,
  ChatRefuse,
  ChatNewAsk,
  ChatWriteProgress,
  ChatMember,
  ChatChange,
  ChatConversation,
  ChatCreate,
  ChatEdit,
  ChatMessage,
  ChatPatch,
  ChatNotifications,
  ChatPost,
  ChatRead,
  ChatSettings,
  PoolConfig,
  PoolFounderAction,
  PoolHostFacts,
  PoolNextRequest,
  PoolSandboxRequest,
  PoolStateUpdate,
  PoolCurrent,
} from "@t3tools/contracts";
import { createPool } from "./pool.ts";
import { openAlarmStore, type Alarm } from "./alarms.ts";
import { rawPublicKey, publicKeyFromBase64, verify } from "./signing.ts";
import { loadSpec, type SchemaName } from "./spec.ts";
import { checkStagePlan, type StagePlan } from "./stage-plan.ts";

/**
 * A fake /relay/v1 relay: a test double and conformance target. By default everything lives in
 * memory, so every start is an empty store. Enrolment has no browser page; tests confirm, approve and refuse
 * pairings through the methods below or the HTTP control surface under /conformance/v1 (see FAKE.md).
 */

export type Role = string;
type Admission = "member" | "outside";
type OutsideReason =
  | "outside_check_pending"
  | "outside_grant_lost"
  | "outside_entry_removed"
  | "outside_2fa_off"
  | "outside_identity_mismatch";
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
  | "capacity"
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
  | "role_permission_missing"
  | "chat_post_restricted"
  | "chat_not_member"
  | "chat_invite_restricted"
  | "chat_outsiders_not_allowed"
  | "chat_manage_restricted"
  | "chat_dm_restricted"
  | "chat_agent_capped"
  | "role_in_use"
  | "role_not_for_outside"
  | "chat_request_closed"
  | "unavailable"
  | "internal";

export interface PersonInput {
  readonly login: string;
  readonly displayName?: string;
  readonly role?: Role;
  readonly admission?: Admission;
  readonly repoKeys?: readonly string[];
  readonly outsideReason?: OutsideReason;
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
  readonly skills?: ReadonlyArray<{
    name: string;
    description: string;
    text: string;
    locked: boolean;
  }>;
  readonly roles?: { default?: string; outsideDefault?: string };
  readonly chat?:
    | boolean
    | {
        readonly defaultChannels?: readonly string[];
        readonly requests?: {
          expireAfter?: string;
          retryAfterDecline?: string;
          maxPendingPerPerson?: number;
        };
        readonly deliveries?: { expireAfter?: string; inboxExpireAfter?: string };
        readonly channels?: { maxMembers?: number };
        readonly boards?: readonly { board: string; channel: string }[];
      };
  readonly officeFixture?: "company" | "community";
  readonly teamPreset?: "company" | "community";
  readonly promote?: boolean;
  readonly search?: boolean;
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
  readonly displayName?: string;
  readonly id: string;
  readonly login: string;
  role: Role;
  admission: Admission;
  repoKeys?: readonly string[];
  outsideReason?: OutsideReason;
  networkIdentity: string | null;
  removed: boolean;
}

interface MachineFacts {
  readonly share?: "hidden" | "agents_only" | "agents_and_name";
  readonly shareUsage?: boolean;
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
 * README, Team: the team state of each session a heartbeat carries. Stopped sessions are kept for one hour; a wait whose
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
    const state =
      fact.state === "stopped"
        ? "stopped"
        : fact.state === "working"
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
  readonly stopReason?: string;
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
  readonly state: "working" | "waiting" | "idle" | "stopped";
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
  refusedLogin?: string;
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
  /** By session id: the team state of each session the latest heartbeat carried or retained. */
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
  capacity: 409,
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
  role_permission_missing: 403,
  chat_post_restricted: 403,
  chat_not_member: 403,
  chat_invite_restricted: 403,
  chat_outsiders_not_allowed: 403,
  chat_manage_restricted: 403,
  chat_dm_restricted: 403,
  chat_agent_capped: 403,
  role_in_use: 409,
  role_not_for_outside: 409,
  chat_request_closed: 409,
  unavailable: 503,
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
const TEAM_SESSIONS_MAX = 300;
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

// Choose the longest prefix that fits, including the serialized cursor and enclosing object.
function boundedPage<T>(
  rows: readonly T[],
  offset: number,
  limit: number,
  bytes: number,
  envelope: (items: readonly T[], cursor: string | null) => unknown,
) {
  let low = 0,
    high = Math.min(limit, Math.max(0, rows.length - offset));
  const cursor = (length: number) =>
    offset + length < rows.length ? encodeCursor(offset + length) : null;
  if (
    Buffer.byteLength(JSON.stringify(envelope(rows.slice(offset, offset + high), cursor(high)))) >
    bytes
  ) {
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (
        Buffer.byteLength(JSON.stringify(envelope(rows.slice(offset, offset + mid), cursor(mid)))) >
        bytes
      )
        high = mid - 1;
      else low = mid;
    }
  }
  return { items: rows.slice(offset, offset + high), nextCursor: cursor(high) };
}

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
  chat_join_requests: 2,
  agent_inbox: 3,
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
  const chatConfig = typeof options.chat === "object" ? options.chat : undefined;
  const defaultNames = chatConfig?.defaultChannels ?? (options.chat ? ["general"] : []);
  const duration = (value: string) => {
    const match = /^(\d+)(s|m|h|d)$/.exec(value);
    if (!match) throw new Error("Invalid chat duration: " + value);
    return (
      Number(match[1]) *
      { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2] as "s" | "m" | "h" | "d"]
    );
  };
  const requestLifetime = duration(chatConfig?.requests?.expireAfter ?? "14d");
  const declineCooldown = duration(chatConfig?.requests?.retryAfterDecline ?? "7d");
  const deliveryLifetime = duration(chatConfig?.deliveries?.expireAfter ?? "24h");
  const inboxLifetime = duration(chatConfig?.deliveries?.inboxExpireAfter ?? "7d");
  const maxPending = chatConfig?.requests?.maxPendingPerPerson ?? 5;
  const maxMembers = chatConfig?.channels?.maxMembers ?? 200;
  if (spec.check("ChatDefaultChannels", defaultNames))
    throw new Error("Invalid chat.defaultChannels.");
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

  const roles = new Map(Object.entries(templates));
  const roleOf = (p: Person) => roles.get(p.role)!;
  const has = (p: Person, key: string) => roleOf(p).permissions[key] === true;
  const roleRef = (p: Person) => ({ id: p.role, name: roles.get(p.role)?.name ?? p.role });
  const personRef = (p: Person) => ({ id: p.id, login: p.login });
  const account = (p: Person) => ({ ...personRef(p), role: roleRef(p), admission: p.admission });
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

  const unrestricted = (p: Person) =>
    roleOf(p).permissions["scope.boards"] === "all" && !p.repoKeys && p.admission !== "outside";
  const boardAllowed = (p: Person, board: string | undefined) => {
    if (unrestricted(p)) return true;
    const scope = roleOf(p).permissions["scope.boards"];
    return (
      !!board &&
      (scope === "all" || (Array.isArray(scope) && scope.includes(board))) &&
      ((!p.repoKeys && p.admission !== "outside") ||
        boardTasks.some(
          (t) => t.board === board && t.projectKey && p.repoKeys?.includes(t.projectKey),
        ))
    );
  };
  const taskAllowed = (p: Person, t: BoardTask) =>
    boardAllowed(p, t.board) &&
    ((!p.repoKeys && p.admission !== "outside") ||
      (!!t.projectKey && !!p.repoKeys?.includes(t.projectKey)));
  const recordAllowed = (p: Person, id: string | null) =>
    unrestricted(p) || boardTasks.some((t) => t.id === id && taskAllowed(p, t));
  const reposFor = (p: Person) =>
    repositories.filter(
      (r) =>
        unrestricted(p) ||
        boardTasks.some((t) => t.projectKey === r.projectKey && taskAllowed(p, t)),
    );
  const peopleAllowed = (p: Person, id: string) =>
    id === p.id || roleOf(p).permissions["scope.people"] === "all" || shared(p.id, id);
  const personFor = (input: PersonInput): Person => {
    const existing = peopleByLogin.get(input.login);
    if (existing && !existing.removed) {
      if (
        input.role &&
        (!roles.has(input.role) ||
          (existing.admission === "outside" && !roles.get(input.role)?.forOutside))
      )
        throw new RelayError("role_not_for_outside", "Choose an eligible role.");
      // Enrolling a second machine preserves the current staff assignment.
      if (input.networkIdentity !== undefined) existing.networkIdentity = input.networkIdentity;
      return existing;
    }
    const person: Person = {
      // A lease seeded for this login before it enrolled already carries an id; keep it.
      id: holderIds.get(input.login) ?? randomId("p"),
      login: input.login,
      ...(input.displayName && { displayName: input.displayName }),
      role:
        input.role ??
        (input.admission === "outside"
          ? (options.roles?.outsideDefault ?? "outside")
          : (options.roles?.default ?? "staff")),
      ...(input.repoKeys && { repoKeys: input.repoKeys }),
      admission: input.admission ?? "member",
      ...(input.outsideReason && { outsideReason: input.outsideReason }),
      networkIdentity: input.networkIdentity ?? null,
      removed: false,
    };
    if (!roles.has(person.role) || (person.admission === "outside" && !roleOf(person).forOutside))
      throw new RelayError("role_not_for_outside", "Choose a role allowed for this person.");
    if (person.admission === "member" && has(person, "channels.seePublic"))
      for (const channel of defaultChannels) channel.members.add(person.id);
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
    if (pairing.poolHost && !has(person, "relay.admin")) {
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

  const refusePairing = (pairingId: string, reason: Refusal, login?: string): PairingState => {
    const pairing = pairingById(pairingId);
    if (isOpen(pairing)) {
      if (!pairing.poolHost && !pairing.personId && !login)
        throw new RelayError("malformed", "Supply the signed-in login for a refused pairing.");
      if (login) pairing.refusedLogin = login;
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
      throw new RelayError(
        "token_revoked",
        "This machine was revoked; enrol again.",
        people.get(machine.personId)?.outsideReason
          ? { reason: people.get(machine.personId)!.outsideReason }
          : undefined,
      );
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
    if (person?.admission === "outside" && person.outsideReason) {
      const reason = person.outsideReason;
      throw new RelayError(
        reason === "outside_check_pending" ? "unavailable" : "token_revoked",
        reason === "outside_check_pending"
          ? "Outside access could not be checked."
          : "Outside access ended.",
        { reason },
      );
    }
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
      revocable: !revoked && (machine.personId === viewer.id || has(viewer, "relay.admin")),
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

  const visibleToColleagues = (machine: Machine) =>
    !machine.poolHost && machine.revokedAt === null && machine.facts.share === "agents_and_name";

  const visibleMachines = (viewer: Person) => [
    ...liveMachines().filter(
      (m) =>
        m.personId === viewer.id ||
        (has(viewer, "hub.machinesAll") && (has(viewer, "relay.admin") || visibleToColleagues(m))),
    ),
    ...[...machines.values()]
      .filter(
        (machine) =>
          !machine.poolHost &&
          machine.revokedAt !== null &&
          (machine.personId === viewer.id || has(viewer, "relay.admin")),
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
    boardTasks
      .filter((t) => taskAllowed(viewer, t))
      .flatMap((task) =>
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
    const recipient = options.criticalRecipients?.includes(person.id) ?? has(person, "relay.admin");
    const critical =
      recipient && has(person, "hub.health")
        ? activeAlarms().filter((a) => a.severity === "critical")
        : [];
    return byUrgency([
      ...(needs.get(person.id) ?? []).filter(
        (i) => i.kind !== "health" || has(person, "hub.health"),
      ),
      ...chatNeeds(person),
      ...requestNeeds(person),
      ...approvalNeeds(person),
      ...(has(person, "relay.admin") ? pool.needs().map((need, seq) => ({ ...need, seq })) : []),
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
      if (!machine.facts.share || machine.facts.share === "hidden") return [];
      const owner = people.get(machine.personId);
      const live = machine.sessions.filter(
        (session) =>
          session.state !== "stopped" &&
          peopleAllowed(person, machine.personId) &&
          (unrestricted(person) ||
            recordAllowed(person, session.taskId ?? taskForBranch(session)?.id ?? null)),
      );
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
        sources.size === 0 || !has(person, "hub.health")
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
  const shippedBlock = (person: Person, since: number | null) => {
    const items = boardTasks
      .flatMap((task, index) =>
        task.prs.flatMap((pr) =>
          !taskAllowed(person, task) ||
          pr.mergedAt === null ||
          (since !== null && pr.mergedAt <= since)
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
      shipped: boardSeeded ? shippedBlock(caller.person, since) : notConfigured("work_tracker"),
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
  const foldTracker = (
    tracker: TrackerIssue,
    now: number,
    onTransition?: Parameters<typeof foldLease>[1],
  ): LeaseFoldResult =>
    foldLease(
      {
        comments: tracker.comments,
        assignees: tracker.assignees,
        labels: tracker.labels,
        founders: [...peopleByLogin.values()]
          .filter((person) => person.removed !== true && has(person, "relay.admin"))
          .map((person) => person.login),
        now: iso(now),
      },
      onTransition,
    );

  // The lease a card shows. A tracker-backed task folds its comments; `active` then ages from the holder's latest
  // comment or heartbeat, while `conflict` and `incomplete` never age.
  const leaseOf = (task: BoardTask, now: number) => {
    if (task.tracker === null) {
      return task.holder === null
        ? undefined
        : {
            holder: task.holder,
            claim: task.holder.login + "/private",
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
    const claim = task.tracker.comments.find(
      (c) =>
        c.author?.toLowerCase() === holder.toLowerCase() &&
        c.createdAt === folded.since &&
        c.updatedAt === c.createdAt,
    );
    const line = claim && parseLeaseLine(claim.body);
    const suffix = line?.kind === "claim" ? line.agent : undefined;
    const named =
      suffix &&
      liveMachines().some(
        (m) =>
          m.personId === peopleByLogin.get(holder)?.id &&
          m.facts.share === "agents_and_name" &&
          (m.id === suffix || m.facts.label.replace(/[^A-Za-z0-9._-]+/g, "-") === suffix),
      );
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
      claim: holder + "/" + (named ? suffix : "private"),
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
          canApprove: canApprove.map((p) =>
            !viewer || peopleAllowed(viewer, p.id) ? p : { login: p.login },
          ),
          youCanApprove: canApprove.some((p) => p.id === viewer?.id),
          ...(pr.checks === null ? {} : { checks: { state: pr.checks } }),
        };
      }),
      restsOn: viewer ? task.restsOn.filter((id) => recordAllowed(viewer, id)) : task.restsOn,
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
    return boards
      .filter((b) => boardAllowed(viewer, b.id))
      .map((config) => {
        const own = cards
          .filter((entry) => entry.board === config.id && recordAllowed(viewer, entry.card.task.id))
          .map((entry) => entry.card);
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
  const mapView = (viewer: Person) => {
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
      allowed: taskAllowed(viewer, task),
      view: cardView(task, index, now),
      ref: taskRefView(task, index),
    }));
    const findCard = (item: StagePlan["items"][number]) =>
      item.task === undefined
        ? undefined
        : cards.find(
            ({ ref, allowed }) =>
              allowed &&
              ref.ref.tracker === item.task?.tracker &&
              ref.ref.scope === item.task.scope &&
              ref.ref.key === item.task.key &&
              // The fake's board has no host, so a plan that names one matches nothing.
              item.task.host === undefined,
          );
    const scopedItems = unrestricted(viewer)
      ? plan.items
      : plan.items.filter((item) => findCard(item));
    const planned = new Map(scopedItems.map((item) => [item.id, item] as const));
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
      const blockedBy = [...new Set(item.restsOn ?? [])].filter(
        (target) => planned.has(target) && BLOCKING.has(resolve(target).status),
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
    const items = scopedItems
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
          restsOn: (item.restsOn ?? []).filter((id) => planned.has(id)),
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
  const feedFile = (viewer: Person) =>
    page(
      feedRecords.filter((r) => recordAllowed(viewer, r.taskId)).map(feedEntryView),
      0,
      SNAPSHOT_FEED_MAX,
    );
  const graveyardFile = (viewer: Person) =>
    page(
      graveyardRecords.filter((r) => recordAllowed(viewer, r.taskId)).map(graveyardEntryView),
      0,
      SNAPSHOT_FEED_MAX,
    );
  const entriesPage = <T>(p: { items: T[]; nextCursor: string | null }) => ({
    entries: p.items,
    nextCursor: p.nextCursor,
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

  const presence = new Map<string, TeamPresenceValues>();
  const meetings = new Map<string, string>();
  const teamPeople = (viewer: Person) =>
    [...people.values()]
      .filter((p) => !p.removed && peopleAllowed(viewer, p.id))
      .sort((a, b) => a.login.localeCompare(b.login))
      .map((p) => {
        const { seatBoard, ...state } = presence.get(p.id) ?? { presence: "off" as const };
        return {
          ...account(p),
          ...(p.displayName && { displayName: p.displayName }),
          ...state,
          ...(seatBoard && boardAllowed(viewer, seatBoard) && { seatBoard }),
        };
      });

  const fixtureSessions: {
    board: string;
    heardAt: number;
    session: { id: string; personId: string; provider: string; state: string; since: string };
  }[] = [];
  const teamSessions = (viewer: Person) => {
    const now = Date.now();
    const rows = liveMachines()
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .flatMap((machine) => {
        const heardAt = machine.lastHeardAt;
        if (
          !machine.facts.share ||
          machine.facts.share === "hidden" ||
          heardAt === null ||
          now - heardAt > TEAM_FORGET_MS
        )
          return [];
        return machine.sessions.flatMap((fact) => {
          const team = machine.teamStates.get(fact.sessionId);
          if (!team || (team.state === "stopped" && now - team.since >= 3600000)) return [];
          const stale = team.state !== "stopped" && now - heardAt > NOT_HEARD_FROM_MS;
          const taskId = fact.taskId ?? taskForBranch(fact)?.id;
          const board = boards.find((b) =>
            boardTasks.some((t) => t.board === b.id && t.id === taskId),
          )?.id;
          const handle = [...handles.values()].find(
            (h) => h.view.machine.id === machine.id && h.threadRef === fact.threadId,
          );
          return [
            {
              board,
              heardAt,
              session: {
                id: fact.sessionId,
                personId: machine.personId,
                provider: fact.provider,
                ...(handle && { handle: label(handle.view) }),
                ...(board && taskId && { taskId }),
                ...(fact.parentSessionId && { parentId: fact.parentSessionId }),
                ...(machine.facts.share === "agents_and_name" && { machineId: machine.id }),
                state: stale ? "not_heard_from" : team.state,
                ...(team.state === "stopped" &&
                  machine.facts.shareUsage &&
                  fact.stopReason && {
                    stopReason:
                      fact.stopReason === "error"
                        ? "failed"
                        : fact.stopReason === "killed"
                          ? "interrupted"
                          : fact.stopReason,
                  }),
                ...(!stale && team.state === "waiting" && { waiting: fact.waiting }),
                since: iso(stale ? heardAt : team.since),
              },
            },
          ];
        });
      });
    rows.push(...fixtureSessions);
    const scoped = rows.filter(
      (r) => peopleAllowed(viewer, r.session.personId) && boardAllowed(viewer, r.board),
    );
    const visibleIds = new Map(
      [...Map.groupBy(scoped, (r) => r.session.personId)].map(([id, owned]) => [
        id,
        new Set(owned.map((r) => r.session.id)),
      ]),
    );
    for (const { session } of rows) {
      if (
        session.parentId === session.id ||
        !visibleIds.get(session.personId)?.has(session.parentId ?? "")
      )
        delete session.parentId;
    }
    return scoped;
  };

  const teamPage = <K extends string, T>(
    key: K,
    rows: readonly T[],
    offset: number,
    limit: number,
    bytes: number,
  ) => {
    const page = boundedPage(rows, offset, limit, bytes, (items, nextCursor) => ({
      [key]: items,
      nextCursor,
    }));
    return { [key]: page.items, nextCursor: page.nextCursor };
  };

  const teamSummary = (
    viewer: Person,
    staff: ReturnType<typeof teamPeople>,
    rows: ReturnType<typeof teamSessions>,
  ) => {
    const owners = Map.groupBy(rows, (row) => row.session.personId);
    const desks = new Map(boards.map((b) => [b.id, new Set<string>()]));
    const active = new Map(boards.map((b) => [b.id, new Set<string>()]));
    const counts = new Map(boards.map((b) => [b.id, emptyCounts()]));
    const hallway = emptyCounts();
    for (const task of boardTasks) {
      const holder = leaseOf(task, Date.now())?.holder;
      if (holder && peopleAllowed(viewer, holder.id) && taskAllowed(viewer, task))
        desks.get(task.board)?.add(holder.id);
    }
    const agents = [...owners]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([personId, owned]) => {
        const boardFor = new Map(owned.map((r) => [r.session.id, r.board]));
        const waiting = new Map<string, number>();
        for (const row of owned) {
          if (!row.board) continue;
          desks.get(row.board)?.add(personId);
          if (row.session.state !== "stopped") active.get(row.board)?.add(personId);
          waiting.set(row.board, 0);
        }
        const total = emptyCounts();
        for (const { session, state } of leadSessions(owned.map((r) => r.session))) {
          total[state]++;
          const board = boardFor.get(session.id);
          const roomCounts = board ? counts.get(board)! : hallway;
          roomCounts[state]++;
          if (board && state === "waiting") waiting.set(board, (waiting.get(board) ?? 0) + 1);
        }
        return {
          personId,
          counts: total,
          rooms: boards
            .filter((b) => waiting.has(b.id))
            .map((b) => ({ board: b.id, waiting: waiting.get(b.id)! })),
        };
      });
    for (const p of staff) {
      if (p.presence !== "available" && p.presence !== "focusing") continue;
      const seat =
        p.seatBoard && desks.get(p.seatBoard)?.has(p.id)
          ? p.seatBoard
          : boards.find((b) => desks.get(b.id)?.has(p.id))?.id;
      if (seat) active.get(seat)?.add(p.id);
    }
    const rooms = boards
      .filter((b) => boardAllowed(viewer, b.id))
      .map((b) => ({
        board: b.id,
        counts: counts.get(b.id)!,
        desks: desks.get(b.id)!.size,
        active: active.get(b.id)!.size,
        ...(meetings.has(b.id) && { meetingUrl: meetings.get(b.id) }),
      }));
    return {
      rooms,
      hallway: { counts: hallway },
      agents,
      office: meetings.has("") ? { meetingUrl: meetings.get("") } : {},
      people: { total: staff.length },
    };
  };
  const teamFiles = (viewer: Person): ReadonlyArray<readonly [string, SchemaName, unknown]> => {
    if (!has(viewer, "hub.team")) return [];
    const staff = teamPeople(viewer);
    const rows = teamSessions(viewer);
    const { agents, ...summary } = teamSummary(viewer, staff, rows);
    const first = boundedPage(agents, 0, agents.length, 65536, (items, nextCursor) => ({
      ...summary,
      agents: items,
      agentsNextCursor: nextCursor,
    }));
    const roomFile = (board?: string) =>
      teamPage(
        "sessions",
        rows.filter((r) => r.board === board).map((r) => r.session),
        0,
        TEAM_SESSIONS_MAX,
        96 * 1024,
      );
    return [
      [
        "team",
        "SnapshotTeam",
        { ...summary, agents: first.items, agentsNextCursor: first.nextCursor },
      ],
      [
        "team.people",
        "SnapshotTeamPeople",
        teamPage("people", staff, 0, TEAM_PEOPLE_MAX, 160 * 1024),
      ],
      ["team.hallway", "SnapshotTeamRoom", roomFile()],
      ...boards
        .filter((b) => boardAllowed(viewer, b.id))
        .map((b) => [`team.room.${b.id}`, "SnapshotTeamRoom", roomFile(b.id)] as const),
    ];
  };

  // Snapshot (README, Snapshot). A head is rebuilt on every change and on every read, so a served head is always
  // current. Files are content-addressed and shared, but a read checks the caller's own retained heads.
  const buildSnapshotFiles = (
    person: Person,
    sharedTeam = teamFiles(person),
  ): Record<string, string> => {
    const blocks = todayBlocks(person);
    const machineList = liveMachines()
      .filter(
        (machine) =>
          (machine.personId === person.id || has(person, "hub.machinesAll")) &&
          machine.facts.share === "agents_and_name",
      )
      .map((machine) => machineView(machine, person));
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
          items: reposFor(person).slice(0, SNAPSHOT_REPOSITORIES_MAX),
          truncated: reposFor(person).length > SNAPSHOT_REPOSITORIES_MAX,
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
        : [["map", "SnapshotMap", mapView(person)] as readonly [string, SchemaName, unknown]]),
      ["feed", "FeedPage", entriesPage(feedFile(person))],
      ["graveyard", "GraveyardPage", entriesPage(graveyardFile(person))],
      ...sharedTeam,
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

  const refreshHead = (person: Person, sharedTeam = teamFiles(person)): SnapshotHeadRecord => {
    const refs = buildSnapshotFiles(person, sharedTeam);
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
    if (snapshotHeads.size === 0) return;

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

  const ownersAllowingDmReads = new Set<string>();
  const preferences = new Map<string, ChatNotifications>();
  type Access = Extract<ChatConversation, { kind: "channel" }>["access"];
  const channelAccess = (template = "team"): Access => ({
    visibility: ["private", "shared"].includes(template) ? "private" : "public",
    join: ["private", "shared"].includes(template)
      ? "invite"
      : template === "community"
        ? "request"
        : "open",
    outsiders: template === "community" ? "listed" : template === "shared" ? "invited" : "none",
    post: template === "announcement" ? "managers" : "everyone",
    replies: "everyone",
    invite: ["announcement", "community", "shared"].includes(template) ? "managers" : "members",
  });
  const wakeDefaults = new Map<string, ChatHandle["wake"]>();
  type Channel = {
    dmKey?: string;
    id: string;
    name: string;
    purpose: string;
    access: Access;
    managers: Set<string>;
    agents: ChatConversation["agents"];
    archived: boolean;
    members: Set<string>;
  };
  const channels = new Map<string, Channel>();
  type Handle = { view: ChatHandle; threadRef: string };
  const handles = new Map<string, Handle>();
  const deliveries = new Map<string, { row: ChatDelivery; claimedAt: number }>();
  const agentHops = new Map<string, number>();
  const pairWrites = new Map<string, number[]>();
  const label = (h: ChatHandle) => h.owner.login + "/" + (h.shortName ?? h.claimName);
  const retiredHandles = new Map<string, ChatHandle>();
  const member = (id: string): ChatMember => {
    const h = handles.get(id)?.view ?? retiredHandles.get(id);
    return h
      ? { kind: "agent", id, handle: label(h), ownerLogin: h.owner.login }
      : { kind: "person", ...account(people.get(id)!) };
  };
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
  const follows = new Map<string, Set<string>>();
  const reactions = new Map<string, Map<string, Set<string>>>();
  const messageView = (m: ChatMessage, person: string): ChatMessage => ({
    ...m,
    reactions: [...(reactions.get(m.id) ?? [])]
      .filter(([, ids]) => ids.size > 0)
      .map(([emoji, ids]) => ({ emoji, count: ids.size, mine: ids.has(person) })),
  });
  const taskThreads = new Map<string, string>();
  let chatSeq = 0;
  const defaultChannels = defaultNames.map((name) => {
    const channel: Channel = {
      id: "c_" + name,
      name,
      purpose: "",
      access: channelAccess(),
      managers: new Set(),
      agents: "allowed",
      archived: false,
      members: new Set(),
    };
    channels.set(channel.id, channel);
    return channel;
  });
  if (!options.officeFixture) personFor({ login: "cy-example", role: "staff" });
  const visible = (c: Channel, id: string) => {
    const p = people.get(id);
    return (
      !!p &&
      (c.members.has(id) ||
        (!c.dmKey &&
          c.access.visibility === "public" &&
          (p.admission === "outside"
            ? c.access.outsiders === "listed"
            : has(p, "channels.seePublic"))))
    );
  };
  const shared = (a: string, b: string) =>
    [...channels.values()].some(
      (c) => !c.dmKey && !c.archived && c.members.has(a) && c.members.has(b),
    );
  const dmAllowed = (sender: Person, ids: Set<string>) => {
    if (ids.size > 2 && (sender.admission === "outside" || !has(sender, "dm.group"))) return false;
    const participants = [...ids].map(
      (id) => people.get(id) ?? people.get(handles.get(id)?.view.owner.id ?? ""),
    );
    return (
      [...ids].every(
        (id) =>
          !handles.has(id) ||
          handles.get(id)!.view.owner.id === sender.id ||
          (sender.admission !== "outside" && has(sender, "agents.dm")),
      ) &&
      participants.every(
        (p) =>
          p &&
          !p.removed &&
          participants.every((other) => {
            if (!other || other.id === p.id) return true;
            const start = roleOf(p).permissions["dm.start"];
            return (
              (start === "anyone" || start === "shared_channel") &&
              ((start === "anyone" && p.admission !== "outside" && other.admission !== "outside") ||
                shared(p.id, other.id)) &&
              (p !== sender || other.admission !== "outside" || has(p, "dm.outsiders"))
            );
          }),
      )
    );
  };
  type JoinRequest = {
    id: string;
    conversationId: string;
    requester: PersonView;
    note?: string;
    state: "pending" | "approved" | "declined" | "cancelled" | "expired" | "void";
    createdAt: string;
    closedBy?: PersonView;
  };
  const requests = new Map<string, JoinRequest>();
  const declinedAt = new Map<string, number>();
  const settleRequests = () => {
    for (const r of requests.values()) {
      if (r.state !== "pending") continue;
      const c = channels.get(r.conversationId),
        p = people.get(r.requester.id);
      if (!c || !p || p.removed || !rights(c, p).request) r.state = "void";
      else if (Date.now() - Date.parse(r.createdAt) >= requestLifetime) r.state = "expired";
    }
  };
  const pendingRequest = (c: Channel, p: Person) =>
    [...requests.values()].find(
      (r) => r.state === "pending" && r.conversationId === c.id && r.requester.id === p.id,
    );
  const rights = (c: Channel, p: Person) => {
    const read = visible(c, p.id),
      member = c.members.has(p.id),
      manage = !c.dmKey && (has(p, "channels.manageAll") || c.managers.has(p.id));
    const writable = member && !c.archived && (!c.dmKey || dmAllowed(p, c.members));
    const post =
      writable &&
      (manage ||
        c.access.post === "everyone" ||
        (c.access.post === "roles" && !!c.access.postRoles?.includes(p.role)));
    const enter =
      read &&
      !member &&
      !c.archived &&
      !c.dmKey &&
      (p.admission === "member" || c.access.outsiders === "listed");
    return {
      read,
      post,
      reply: writable && (post || c.access.replies === "everyone"),
      join: enter && c.access.join === "open",
      request: enter && c.access.join === "request",
      invite:
        member &&
        !c.dmKey &&
        (manage || (has(p, "channels.invite") && c.access.invite === "members")),
      manage,
      openToOutside: manage && has(p, "channels.openToOutside"),
    };
  };
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
    for (const stream of streams) {
      if (
        (person === undefined || person === stream.personId) &&
        visible(channel, stream.personId)
      ) {
        const change =
          "message" in value
            ? { ...value, message: messageView(value.message, stream.personId) }
            : value;
        const m =
          value.kind === "message.created" && "message" in value ? value.message : undefined;
        const prefs = preferences.get(cursorKey(stream.personId, channel.id));
        const eligible =
          m &&
          m.author.kind !== "system" &&
          m.kind !== "progress" &&
          !(m.author.kind === "person" && m.author.id === stream.personId) &&
          (channel.dmKey ||
            m.ask?.to.id === stream.personId ||
            (channel.members.has(stream.personId) &&
              !prefs?.muted &&
              prefs?.notify !== "nothing" &&
              (prefs?.notify === "all" ||
                m.mentions.some((t) => t.id === stream.personId) ||
                (m.threadRootId && follows.get(m.threadRootId)?.has(stream.personId)))));
        const hint = {
          seq: value.seq,
          ...(eligible
            ? {
                notice: {
                  messageId: m.id,
                  author: m.author.kind === "person" ? m.author.login : m.author.handle,
                  text: m.text.slice(0, 240),
                },
              }
            : {}),
        };
        const inline = { ...hint, change };
        const event = Buffer.byteLength(JSON.stringify(inline)) <= 8192 ? inline : hint;
        stream.response.write(`event: chat.changed\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }
    if (("message" in value && value.message.kind !== "progress") || value.kind === "read.moved") {
      for (const p of people.values()) {
        if (p.removed || !visible(channel, p.id) || (person && person !== p.id)) continue;
        if (
          "message" in value &&
          !channel.dmKey &&
          value.message.ask?.to.id !== p.id &&
          !value.message.mentions.some((t) => t.id === p.id) &&
          value.kind === "message.created"
        )
          continue;
        const items = personalNeeds(p);
        const item =
          "message" in value &&
          items.find((i) => i.id === (value.message.ask?.id ?? value.message.id));
        if (item && value.kind === "message.created")
          emit("mention", "MentionEvent", { at: value.message.createdAt, item }, p.id);
        emit(
          "needs.changed",
          "NeedsChangedEvent",
          { at: iso(Date.now()), count: items.length },
          p.id,
        );
      }
    }
  };
  const channelView = (channel: Channel, person: Person): ChatConversation => {
    const pending = pendingRequest(channel, person);
    const roots = [...messages.values()].filter(
      (m) => visible(channel, person.id) && m.conversationId === channel.id && !m.threadRootId,
    );
    const readSeq = cursors.get(cursorKey(person.id, channel.id)) ?? 0;
    const unread = roots.filter(
      (m) =>
        m.kind !== "progress" &&
        !m.deleted &&
        m.seq > readSeq &&
        (m.author.kind === "system" || m.author.id !== person.id),
    );
    return {
      id: channel.id,
      ...(channel.dmKey
        ? {
            kind: "dm" as const,
            private: true as const,
            agentReaders: [...channel.members]
              .filter(
                (id) =>
                  [...channel.members].every((id) => people.has(id)) &&
                  ownersAllowingDmReads.has(id),
              )
              .map((personId) => ({ personId, login: people.get(personId)!.login })),
            members: [...channel.members].map(member),
          }
        : {
            kind: "channel" as const,
            ...(defaultChannels.includes(channel) && { defaultChannel: true as const }),
            access: channel.access,
            managers: [...channel.managers].map((id) => personRef(people.get(id)!)),
            name: channel.name,
          }),
      purpose: channel.purpose,
      agents: channel.agents,
      archived: channel.archived,
      memberCount: {
        people: [...channel.members].filter((id) => people.has(id)).length,
        agents: [...channel.members].filter((id) => handles.has(id)).length,
      },
      lastSeq: roots.at(-1)?.seq ?? 0,
      me: {
        ...(pending && { request: { id: pending.id, createdAt: pending.createdAt } }),
        can: { ...rights(channel, person), request: !pending && rights(channel, person).request },
        member: channel.members.has(person.id),
        ...(preferences.get(cursorKey(person.id, channel.id)) ?? {
          notify: "mentions",
          muted: false,
        }),
        readSeq,
        unread: unread.length,
        mentions: unread.filter((m) => m.mentions.some((t) => t.id === person.id)).length,
      },
    };
  };

  function systemMessage(
    channel: Channel,
    taskRef: string | undefined,
    systemEvent: string,
    text: string,
    root?: ChatMessage,
  ) {
    const m: ChatMessage = {
      id: randomId("m"),
      conversationId: channel.id,
      seq: ++chatSeq,
      author: { kind: "system" },
      kind: "system",
      systemEvent,
      ...(taskRef && { taskRef }),
      text: text.replace(/\s+/g, " "),
      mentions: [],
      reactions: [],
      replyCount: 0,
      createdAt: iso(Date.now()),
      deleted: false,
      ...(root ? { threadRootId: root.id } : {}),
    };
    messages.set(m.id, m);
    if (root)
      messages.set(root.id, { ...root, replyCount: root.replyCount + 1, lastReplyAt: m.createdAt });
    chatChange(channel, { kind: "message.created", seq: m.seq, message: m });
    return m;
  }
  function echoLease(task: BoardTask, event: string, text: string) {
    const root = messages.get(taskThreads.get(task.id) ?? "");
    if (root) systemMessage(channels.get(root.conversationId)!, task.id, event, text, root);
  }

  const deliveryReadable = (d: ChatDelivery, person: Person) => {
    const channel = channels.get(d.message.conversationId);
    return (
      !!channel &&
      (visible(channel, person.id) || (!!channel.dmKey && channel.members.has(d.handleId)))
    );
  };
  function requestNeeds(person: Person): NeedsItem[] {
    settleRequests();
    const pending = [...requests.values()].filter(
      (r) => r.state === "pending" && rights(channels.get(r.conversationId)!, person).manage,
    );
    const waiting = [...deliveries.values()]
      .map((d) => d.row)
      .filter(
        (d) =>
          !d.wakes &&
          d.state === "pending" &&
          Date.parse(d.expiresAt) > Date.now() &&
          handles.get(d.handleId)?.view.owner.id === person.id &&
          deliveryReadable(d, person),
      );
    return [
      ...Array.from(
        Map.groupBy(pending, (r) => r.conversationId),
        ([conversationId, rows]) => ({
          seq: 0,
          id: conversationId,
          conversationId,
          kind: "chat_join_requests",
          count: rows.length,
          title: "Requests to join #" + channels.get(conversationId)!.name,
          createdAt: rows[0]!.createdAt,
        }),
      ),
      ...Array.from(
        Map.groupBy(waiting, (d) => d.handleId),
        ([handleId, rows]) => ({
          seq: 0,
          id: handleId,
          handleId,
          kind: "agent_inbox",
          count: rows.length,
          title: "Waiting agent deliveries",
          createdAt: rows[0]!.message.createdAt,
        }),
      ),
    ];
  }
  function chatNeeds(person: Person) {
    return [...messages.values()].flatMap((m) => {
      const c = channels.get(m.conversationId);
      if (
        c &&
        visible(c, person.id) &&
        !m.deleted &&
        m.ask?.state === "open" &&
        m.ask.to.id === person.id
      )
        return [
          {
            id: m.ask.id,
            ask: m.ask,
            seq: m.seq,
            createdAt: m.createdAt,
            title: m.text.slice(0, 300),
            kind: "chat_ask",
            chatRead: {
              conversationId: m.conversationId,
              threadRootId: m.threadRootId ?? m.id,
              seq: m.seq,
            },
          },
        ];
      if (
        m.kind === "ask" ||
        m.kind === "progress" ||
        !c ||
        !visible(c, person.id) ||
        m.deleted ||
        m.author.kind === "system" ||
        (m.author.kind === "person" && m.author.id === person.id) ||
        (!c.dmKey && !m.mentions.some((t) => t.id === person.id)) ||
        m.seq <= (cursors.get(cursorKey(person.id, c.id, m.threadRootId)) ?? 0)
      )
        return [];
      return [
        {
          seq: m.seq,
          id: m.id,
          createdAt: m.createdAt,
          title: m.text.slice(0, 300),
          kind: c.dmKey ? "agent_message" : "mention",
          chatRead: {
            conversationId: c.id,
            ...(m.threadRootId ? { threadRootId: m.threadRootId } : {}),
            seq: m.seq,
          },
        },
      ];
    });
  }
  const removeStaff = (login: string) => {
    const person = peopleByLogin.get(login);
    if (!person || person.removed) throw new RelayError("not_found", "No such person.");
    presence.delete(person.id);
    person.removed = true;
    for (const c of channels.values()) {
      c.managers.delete(person.id);
      if (!c.dmKey && c.members.delete(person.id) && person.admission === "outside")
        systemMessage(c, undefined, "access_ended", person.login + "'s access ended.");
    }
    for (const [id, h] of handles) {
      if (h.view.owner.id !== person.id) continue;
      for (const c of channels.values())
        if (c.members.has(id)) {
          if (c.dmKey) c.archived = true;
          else c.members.delete(id);
        }
      for (const delivery of deliveries.values())
        if (delivery.row.handleId === id && ["pending", "claimed"].includes(delivery.row.state))
          delivery.row = { ...delivery.row, state: "expired" };
      // Keep the author label for participants reading archived DM history.
      if ([...channels.values()].some((c) => c.dmKey && c.members.has(id)))
        retiredHandles.set(id, h.view);
      handles.delete(id);
    }
    settleRequests();
    ownersAllowingDmReads.delete(person.id);
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
        retryable: error.status === 429 || error.status === 503,
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
          (options.criticalRecipients?.includes(person.id) ?? has(person, "relay.admin"))
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
          ...(options.skills && { skills: { registry: true } }),
          me: {
            id: caller.person.id,
            login: caller.person.login,
            role: roleRef(caller.person),
            admission: caller.person.admission,
            permissions: Object.entries(roleOf(caller.person).permissions).flatMap(([k, v]) =>
              v === true ? [k] : [v].flat().map((x) => k + ":" + x),
            ),
            machineId: caller.machine.id,
          },
          ...(options.chat
            ? {
                chat: {
                  ...(typeof options.chat === "object" &&
                    options.chat.boards && { boards: options.chat.boards }),
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
          ...(has(caller.person, "hub.health") && { dashboards }),
          sections: [
            ...(has(caller.person, "relay.admin")
              ? [{ id: "roles", kind: "roles", version: 1, flags: [] }]
              : []),
            ...(options.chat
              ? [
                  {
                    id: "chat",
                    kind: "chat",
                    version: 1,
                    flags: [
                      ...(options.search === false ? [] : ["search"]),
                      ...(options.promote === false ? [] : ["promote"]),
                      "task_links",
                      "channel_access",
                      "join_requests",
                      "agent_inbox",
                      "channels",
                      "private_channels",
                      "threads",
                      "reactions",
                      "dms",
                      "group_dms",
                      "agents",
                      "asks",
                      "agent_dms",
                      "others_agents",
                      "agent_owner_dm_read",
                    ],
                  },
                ]
              : []),
            ...(options.pool?.enabled && has(caller.person, "hub.pool")
              ? [{ id: "pool", kind: "pool", version: 1, flags: [] }]
              : []),
            ...(sources.size && has(caller.person, "hub.health")
              ? [{ id: "health", kind: "health", version: 1, flags: [] }]
              : []),
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
            ...(has(caller.person, "hub.team")
              ? [
                  {
                    id: "team",
                    kind: "team",
                    version: 2,
                    flags: ["presence", "status", "sharing", "meeting_links"],
                  },
                ]
              : []),
          ],
          ...(has(caller.person, "hub.team") && {
            team: {
              preset: options.officeFixture ?? options.teamPreset ?? "company",
              stoppedKeptSeconds: 3600,
            },
          }),
          // The Hub's agent toolkit, enabled for everyone; the Hub keeps its own descriptions.
          mcpTools: BANNERET_AGENT_TOOLS.filter(
            (name) =>
              (options.chat || !name.startsWith("banneret_chat_")) &&
              ((options.pool?.enabled && has(caller.person, "hub.pool")) ||
                !BANNERET_POOL_TOOLS.some((poolTool) => poolTool === name)),
          ).map((name) => ({
            name,
            description: "A Banneret Hub agent tool.",
            ...(name === "banneret_team" && { requires: "hub.team" }),
            ...(BANNERET_POOL_TOOLS.some((tool) => tool === name) && { requires: "hub.pool" }),
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

    if (method === "GET" && route === "/skills" && options.skills) {
      authenticate(request, body);
      sendJson(response, 200, "SkillsCatalog", { skills: options.skills });
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
      if (pairing.state === "refused" && pairing.personId)
        reply.account = { login: people.get(pairing.personId)!.login };
      if (pairing.state === "refused" && pairing.refusedLogin)
        reply.account = { login: pairing.refusedLogin };
      if (pairing.state === "approved") {
        reply.machineId = pairing.machineId;
        const machine =
          pairing.machineId === undefined ? undefined : machines.get(pairing.machineId);
        const token = machine === undefined ? undefined : reissueToken(machine);
        if (token !== undefined) reply.token = token;
      }
      if (pairing.state === "refused" || pairing.state === "expired") reply.reason = pairing.reason;
      sendJson(response, 200, hostEnroll ? "PoolPollResponse" : "EnrolPollResponse", reply);
      return;
    }

    const statePath = /^\/pool\/sandboxes\/([^/]+)\/state$/.exec(route);
    const caller = authenticate(
      request,
      body,
      isPool && (route.startsWith("/pool/hosts/") || !!statePath),
    );
    if (route === "/roles" || route.startsWith("/roles/") || /^\/staff\/[^/]+\/role$/.test(route)) {
      const p = caller.person;
      if (!has(p, "relay.admin"))
        throw new RelayError(
          "role_permission_missing",
          "Role administration requires relay.admin.",
          { account: account(p), rule: "relay.admin" },
        );
      const [, resource, id, action] = route.split("/");
      const holders = (id: string) =>
        [...people.values()].filter((person) => !person.removed && person.role === id);
      const detail = (id: string) => ({
        id,
        ...roles.get(id),
        ...(Object.hasOwn(templates, id) && { template: id }),
        memberCount: holders(id).length,
      });
      if (route === "/roles" && method === "GET")
        return sendJson(response, 200, "Roles", { items: [...roles.keys()].map(detail) });
      if (!id) throw new RelayError("not_found", "Unknown role.");
      if (resource === "staff" && method === "PUT") {
        const { roleId } = parseJson(body, "RoleAssignment") as { roleId: string };
        const person = people.get(id),
          role = roles.get(roleId);
        if (!person || person.removed || !role)
          throw new RelayError("not_found", "Unknown person or role.");
        if (person.admission === "outside" && !role.forOutside)
          throw new RelayError("role_not_for_outside", "Choose a role for outside collaborators.");
        if (
          has(person, "relay.admin") &&
          !role.permissions["relay.admin"] &&
          ![...people.values()].some(
            (other) => !other.removed && other !== person && has(other, "relay.admin"),
          )
        )
          throw new RelayError("role_in_use", "Keep one administrator.");
        person.role = roleId;
      } else if (resource === "roles" && /^[a-z][a-z0-9_]{0,31}$/.test(id)) {
        if (method === "DELETE" && !action) {
          if (!roles.has(id)) throw new RelayError("not_found", "Unknown role.");
          if (holders(id).length || Object.hasOwn(templates, id))
            throw new RelayError(
              "role_in_use",
              "Move members first. Built-in templates cannot be removed.",
            );
          roles.delete(id);
        } else {
          const role =
            method === "PUT" && !action
              ? (parseJson(body, "RoleWrite") as RoleWrite)
              : method === "POST" && action === "reset" && Object.hasOwn(templates, id)
                ? templates[id]
                : undefined;
          if (!role) throw new RelayError("not_found", "Unknown role operation.");
          if (!role.forOutside && holders(id).some((person) => person.admission === "outside"))
            throw new RelayError("role_not_for_outside", "Outside collaborators hold this role.");
          if (
            holders(id).some((person) => has(person, "relay.admin")) &&
            !role.permissions["relay.admin"] &&
            ![...people.values()].some(
              (person) => !person.removed && person.role !== id && has(person, "relay.admin"),
            )
          )
            throw new RelayError("role_in_use", "Keep one administrator.");
          roles.set(id, role);
        }
      } else throw new RelayError("not_found", "Unknown role operation.");
      for (const person of people.values())
        if (!person.removed && person.admission === "member" && has(person, "channels.seePublic"))
          for (const c of defaultChannels) c.members.add(person.id);
      settleRequests();
      snapshotHeads.clear();
      capabilitiesRevision++;
      emit("roles.changed", "RolesChangedEvent", {}, null);
      if (resource === "roles" && method !== "DELETE")
        return sendJson(response, 200, "RoleDetail", detail(id));
      response.writeHead(204).end();
      return;
    }
    if (isPool) {
      if (!has(caller.person, "hub.pool")) throw new RelayError("not_found", "Pool unavailable.");
      const owner = caller.person.id;
      const host = caller.machine.facts.environmentId;
      const sandbox = /^\/pool\/sandboxes\/([^/]+)(\/extend)?$/.exec(route);
      if (route === "/pool/founder" && (method === "GET" || method === "POST")) {
        if (!has(caller.person, "relay.admin"))
          throw new RelayError("forbidden", "Founder role required.");
        if (method === "POST") {
          const input = parseJson(body, "PoolFounderAction") as PoolFounderAction;
          if (input.action === "limits") pool.setLimits(input.requested);
          else if (input.action === "approve") pool.approve(input.requestId);
          else {
            const pairing = pairingById(input.pairingId);
            if (!pairing.poolHost || pairing.state !== "pending")
              throw new RelayError("not_found", "No pending host enrolment.");
            if (input.action === "refuse") refusePairing(pairing.id, "declined");
            else if (
              confirmPairing(pairing.id, input.code, { login: caller.person.login }) !== "approved"
            )
              throw new RelayError(
                "forbidden",
                "Host confirmation failed. Check the code with the admin.",
              );
          }
          refreshAllHeads();
        }
        const enrolments = [...pairings.values()]
          .filter((p) => {
            if (!p.poolHost) return false;
            settleExpiry(p);
            return p.state === "pending";
          })
          .map((p) => ({ pairingId: p.id, hostId: p.machine.environmentId }));
        return sendJson(response, 200, "PoolFounderView", {
          enrolments,
          hosts: pool.founderHosts(),
          requests: pool.requests(),
        });
      }
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
            publicKey: rawPublicKey(caller.machine.publicKey),
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
      settleRequests();
      const { person } = caller;
      const [, , resource, id = "", action, memberId] = route.split("/");
      const send = (schema: SchemaName, value: unknown) => sendJson(response, 200, schema, value);
      const owned = (id: string) => {
        const h = handles.get(id);
        if (!h || h.view.machine.id !== caller.machine.id || h.view.owner.id !== person.id)
          throw new RelayError("forbidden", "This machine does not own that agent.");
        return h;
      };
      const handleVisible = (h: ChatHandle) =>
        h.owner.id === person.id ||
        (has(person, "agents.mention") &&
          [...channels.values()].some(
            (c) => visible(c, person.id) && (c.members.has(h.owner.id) || c.members.has(h.id)),
          ));
      const reader = query.has("asHandle") ? owned(query.get("asHandle")!) : undefined;
      const canRead = (c: Channel) =>
        reader
          ? (!!c.dmKey && c.members.has(reader.view.id)) ||
            (visible(c, person.id) &&
              (c.access.visibility === "public" ||
                c.members.has(reader.view.id) ||
                (!!c.dmKey &&
                  c.members.has(person.id) &&
                  ownersAllowingDmReads.has(person.id) &&
                  [...c.members].every((id) => people.has(id)))))
          : visible(c, person.id);
      const canReadThread = (c: Channel, rootId: string) =>
        canRead(c) ||
        (visible(c, person.id) &&
          !c.dmKey &&
          !!reader &&
          !!follows.get(rootId)?.has(reader.view.id));
      const channelFor = (id: string) => {
        const c = channels.get(id);
        if (!c || !canRead(c)) throw new RelayError("not_found", "Unknown channel.");
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
        const mentions: ChatMessage["mentions"][number][] = [];
        for (const mention of new Set(text.match(/@[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)?/g) ?? [])) {
          const name = mention.slice(1),
            p = peopleByLogin.get(name);
          const h = [...handles.values()].find((h) => label(h.view) === name);
          if (h && handleVisible(h.view)) mentions.push({ kind: "agent", id: h.view.id });
          else if (p && peopleAllowed(person, p.id)) mentions.push({ kind: "person", id: p.id });
        }
        if (mentions.length > 50) throw new RelayError("malformed", "Too many mentions.");
        return mentions;
      };
      if (
        reader &&
        !(
          (method === "GET" &&
            ["conversations", "threads", "search", "deliveries"].includes(resource ?? "")) ||
          (resource === "messages" && action === "reactions")
        )
      )
        throw new RelayError("forbidden", "This call is unavailable to agents.");
      if (resource === "handles") {
        if (method === "GET" && !id)
          return send(
            "ChatHandles",
            paged([...handles.values()].map((h) => h.view).filter(handleVisible)),
          );
        if (method === "PUT" && id) {
          const data = parseJson(body, "ChatRegister") as ChatRegister;
          const existing = handles.has(id) ? owned(id) : undefined;
          if (
            data.machineId !== caller.machine.id ||
            (existing && data.threadRef !== existing.threadRef)
          )
            throw new RelayError("forbidden", "Choose an agent on this machine.");
          if (data.name && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(data.name))
            throw new RelayError(
              "malformed",
              "Use a short name with lowercase letters, numbers and hyphens.",
            );
          const claimName =
            data.provider +
            "-" +
            data.threadRef
              .replace(/^thread[:_-]?/i, "")
              .replace(/[^a-zA-Z0-9._-]/g, "")
              .slice(0, 8);
          const shortName = data.name ?? existing?.view.shortName;
          const view: ChatHandle = {
            id,
            claimName,
            ...(shortName ? { shortName } : {}),
            owner: { id: person.id, login: person.login },
            machine: { id: data.machineId, label: caller.machine.facts.label },
            provider: data.provider,
            reachable: true,
            wake: data.wake ?? existing?.view.wake ?? wakeDefaults.get(person.id) ?? "everyone",
          };
          if ([...handles.values()].some((h) => h.view.id !== id && label(h.view) === label(view)))
            throw new RelayError("malformed", "That chat name is taken.");
          handles.set(id, { threadRef: data.threadRef, view });
          return send("ChatHandle", view);
        }
      }
      if (resource === "me" && id === "agents" && action === "wake" && method === "PUT") {
        const { wake } = parseJson(body, "ChatWakeSetting") as { wake: ChatHandle["wake"] };
        for (const h of handles.values())
          if (h.view.owner.id === person.id) h.view = { ...h.view, wake };
        response.writeHead(204).end();
        return;
      }
      if (resource === "deliveries" || resource === "inbox") {
        const notDelivered = (d: ChatDelivery) => {
          const original = messages.get(d.messageId)!;
          const note: ChatMessage = {
            id: randomId("m"),
            conversationId: original.conversationId,
            ...(original.threadRootId ? { threadRootId: original.threadRootId } : {}),
            seq: ++chatSeq,
            kind: "system",
            systemEvent: "not_delivered",
            author: { kind: "system" },
            text:
              "Not delivered: " + label(handles.get(d.handleId)!.view) + " could not be reached.",
            mentions: [],
            reactions: [],
            replyCount: 0,
            createdAt: iso(Date.now()),
            deleted: false,
          };
          messages.set(note.id, note);
          chatChange(channels.get(note.conversationId)!, {
            kind: "message.created",
            seq: note.seq,
            message: note,
          });
        };
        const now = Date.now();
        for (const d of deliveries.values()) {
          if (d.row.state !== "pending" && d.row.state !== "claimed") continue;
          if (Date.parse(d.row.expiresAt) <= now) {
            d.row = { ...d.row, state: "expired" };
            if (d.row.wakes) notDelivered(d.row);
          } else if (d.row.state === "claimed" && now - d.claimedAt >= 600000)
            d.row = { ...d.row, state: "pending" };
        }
        if (resource === "inbox") {
          if (method !== "POST" || id) throw new RelayError("not_found", "Unknown inbox call.");
          const { asHandle } = parseJson(body, "ChatAct") as ChatAct;
          owned(asHandle);
          const items = [...deliveries.values()]
            .filter(
              (d) =>
                d.row.handleId === asHandle &&
                !d.row.wakes &&
                d.row.state === "pending" &&
                deliveryReadable(d.row, person),
            )
            .slice(0, 100)
            .map(
              (d) =>
                (d.row = { ...d.row, message: messages.get(d.row.messageId)!, state: "consumed" }),
            );
          if (items.length)
            emit(
              "needs.changed",
              "NeedsChangedEvent",
              { at: iso(now), count: personalNeeds(person).length },
              person.id,
            );
          return send("ChatDeliveries", { items, nextCursor: null });
        }
        const current = (row: ChatDelivery) => ({
          ...row,
          message: messages.get(row.messageId)!,
        });
        if (method === "GET" && !id)
          return send(
            "ChatDeliveries",
            paged(
              [...deliveries.values()]
                .map((d) => d.row)
                .filter(
                  (d) =>
                    deliveryReadable(d, person) &&
                    d.wakes &&
                    d.machineId === caller.machine.id &&
                    (!reader || d.handleId === reader.view.id) &&
                    ["pending", "claimed"].includes(d.state),
                )
                .map(current),
            ),
          );
        if (method === "POST" && id) {
          const act = parseJson(body, action === "refuse" ? "ChatRefuse" : "ChatAct") as
            | ChatAct
            | ChatRefuse;
          owned(act.asHandle);
          const d = deliveries.get(id);
          if (!d || !deliveryReadable(d.row, person) || d.row.handleId !== act.asHandle)
            throw new RelayError("forbidden", "This delivery belongs to another agent.");
          const state =
            action === "claim" && d.row.wakes && ["pending", "claimed"].includes(d.row.state)
              ? "claimed"
              : action === "consume" && d.row.state === "claimed"
                ? "consumed"
                : action === "refuse" && ["pending", "claimed"].includes(d.row.state)
                  ? "refused"
                  : undefined;
          if (!state) throw new RelayError("malformed", "This delivery has already closed.");
          d.row = { ...d.row, state };
          d.claimedAt = now;
          if (state === "refused") notDelivered(d.row);
          return send("ChatDelivery", current(d.row));
        }
      }
      if (resource === "progress" && method === "GET" && !reader) {
        return send(
          "ChatActiveProgress",
          paged(
            [...messages.values()].flatMap((m) => {
              const h = m.author.kind === "agent" && handles.get(m.author.id);
              return h &&
                h.view.machine.id === caller.machine.id &&
                (m.progress?.state === "working" || m.progress?.state === "stale")
                ? [{ threadRef: h.threadRef, handleId: h.view.id, message: m }]
                : [];
            }),
          ),
        );
      }
      if (
        (resource === "messages" && action === "progress" && method === "PUT") ||
        (resource === "asks" && !id && method === "POST")
      ) {
        const progress =
          resource === "messages"
            ? (parseJson(body, "ChatWriteProgress") as ChatWriteProgress)
            : undefined;
        const ask = progress ? undefined : (parseJson(body, "ChatNewAsk") as ChatNewAsk);
        const h = owned((progress ?? ask)!.asHandle).view;
        const root = messages.get(ask?.threadRootId ?? id);
        let c = channels.get(root?.conversationId ?? id);
        const to = ask && (people.get(ask.to) ?? peopleByLogin.get(ask.to));
        if (ask && (!to || to.removed))
          throw new RelayError("not_found", "Choose a current staff member.");
        if (ask && !ask.threadRootId && to) {
          if (
            !dmAllowed(person, new Set([person.id, to.id])) ||
            (to.admission === "outside" && to.id !== person.id)
          )
            throw new RelayError("chat_dm_restricted", "These participants cannot open a DM.", {
              account: account(person),
              rule: "dm.start",
              asHandle: h.id,
              owner: personRef(person),
            });
          const dmKey = JSON.stringify([h.id, to.id].sort());
          c = [...channels.values()].find((c) => c.dmKey === dmKey);
          if (!c) {
            c = {
              id: randomId("c"),
              dmKey,
              name: "",
              purpose: "",
              access: channelAccess("private"),
              managers: new Set(),
              agents: "allowed",
              archived: false,
              members: new Set([h.id, to.id]),
            };
            channels.set(c.id, c);
          }
        }
        if (
          !c ||
          c.archived ||
          c.agents === "off" ||
          (!c.dmKey &&
            (!rights(c, person).reply ||
              (c.agents === "mentions_only" &&
                !(
                  root &&
                  [...messages.values()].some(
                    (m) =>
                      (m.threadRootId ?? m.id) === (root.threadRootId ?? root.id) &&
                      m.mentions.some((t) => t.id === h.id),
                  )
                )))) ||
          (to && !visible(c, to.id)) ||
          (c.access.visibility === "private" &&
            !c.members.has(h.id) &&
            !(root && follows.get(root.threadRootId ?? root.id)?.has(h.id)))
        )
          throw new RelayError("forbidden", "This agent cannot post here.");
        const rootId = root?.kind === "progress" ? root.threadRootId : root?.id;
        if ((root && root.threadRootId && root.kind !== "progress") || (!root && !c.dmKey))
          throw new RelayError("malformed", "Choose a thread or the top of a DM.");
        const prior =
          progress &&
          [...messages.values()].find(
            (m) =>
              m.author.kind === "agent" &&
              m.author.id === h.id &&
              m.conversationId === c.id &&
              m.threadRootId === rootId &&
              (m.progress?.state === "working" || m.progress?.state === "stale"),
          );
        if (root?.kind === "progress" && (!prior || prior.id !== root.id))
          throw new RelayError("malformed", "This progress message is already closed.");
        const key = ask && JSON.stringify([h.id, ask.key]);
        if (key && postKeys.has(key)) {
          const priorAsk = messages.get(postKeys.get(key)!)?.ask;
          if (!priorAsk) throw new RelayError("malformed", "This key already belongs to a post.");
          return send("ChatAsk", priorAsk);
        }
        if (
          ask &&
          [...messages.values()].filter(
            (m) => m.author.kind === "agent" && m.author.id === h.id && m.ask?.state === "open",
          ).length >= 5
        )
          throw new RelayError("rate_limited", "Answer or cancel an open question first.");
        const m: ChatMessage = {
          id: prior ? prior.id : randomId("m"),
          conversationId: c.id,
          ...(rootId ? { threadRootId: rootId } : {}),
          seq: prior ? prior.seq : ++chatSeq,
          author: {
            kind: "agent",
            id: h.id,
            provider: h.provider,
            ownerLogin: person.login,
            handle: label(h),
          },
          kind: progress ? "progress" : "ask",
          text: progress?.text ?? ask!.question,
          ...(progress ? { progress: { state: progress.state, steps: progress.steps ?? [] } } : {}),
          ...(ask && to
            ? {
                ask: {
                  id: randomId("a"),
                  to: { id: to.id, login: to.login },
                  state: "open",
                  choices: ask.choices ?? [],
                },
                ...(ask.taskRef ? { taskRef: ask.taskRef } : {}),
              }
            : {}),
          mentions: [],
          replyCount: prior ? prior.replyCount : 0,
          reactions: [],
          createdAt: prior ? prior.createdAt : iso(Date.now()),
          deleted: false,
        };
        messages.set(m.id, m);
        if (key) postKeys.set(key, m.id);
        if (!prior && rootId) {
          const parent = messages.get(rootId)!;
          messages.set(rootId, {
            ...parent,
            replyCount: parent.replyCount + 1,
            lastReplyAt: m.createdAt,
          });
        }
        chatChange(c, {
          seq: prior ? ++chatSeq : m.seq,
          kind: prior ? "message.edited" : "message.created",
          message: m,
        });
        return m.ask ? send("ChatAsk", m.ask) : send("ChatMessage", m);
      }
      if (resource === "messages" && action === "promote" && method === "POST") {
        if (options.promote === false || body.length)
          throw new RelayError("forbidden", "Promotion is unavailable.");
        const m = messageFor(id);
        if (m.deleted) throw new RelayError("not_found", "Unknown message.");
        const thread = m.threadRootId ? "thread=" + m.threadRootId + "&" : "";
        return send("ChatPromotion", {
          text: m.text,
          link: "/channels/" + m.conversationId + "?" + thread + "message=" + m.id,
        });
      }
      if (resource === "search" && method === "GET") {
        if (options.search === false)
          throw new RelayError("forbidden", "Message search is unavailable.");
        const tokens = (query.get("q") ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length) throw new RelayError("malformed", "Enter a search term or filter.");
        const words = tokens.filter((t) => !/^(in|from|is|kind|has|task|before|after):/.test(t));
        const filters = tokens.filter((t) => !words.includes(t));
        const tokenize = (text: string) =>
          text
            .normalize("NFD")
            .replace(/\p{M}/gu, "")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? [];
        const terms = words.flatMap(tokenize);
        const results = [...messages.values()].reverse().flatMap((m) => {
          const c = channels.get(m.conversationId)!;
          if (
            m.deleted ||
            !canReadThread(c, m.threadRootId ?? m.id) ||
            m.kind === "progress" ||
            m.kind === "system"
          )
            return [];
          const text = m.text.toLowerCase();
          const indexed = new Set(tokenize(text));
          if ((words.length && !terms.length) || !terms.every((t) => indexed.has(t))) return [];
          const author = m.author;
          const ref =
            m.taskRef ?? (m.threadRootId ? messages.get(m.threadRootId)?.taskRef : undefined);
          const matches = filters.every((filter) => {
            const [key, value] = filter.split(":");
            switch (key) {
              case "in":
                return !c.dmKey && "#" + c.name.toLowerCase() === value;
              case "from":
                return author.kind === "person"
                  ? "@" + author.login.toLowerCase() === value
                  : author.kind === "agent" && author.handle.toLowerCase() === value;
              case "is":
                return value === (author.kind === "person" ? "human" : author.kind);
              case "kind":
                return m.kind === value;
              case "has":
                return value === "task" && !!ref;
              case "task":
                return !!ref && boardTasks.some((t, i) => t.id === ref && "#" + (i + 1) === value);
              case "before":
              case "after": {
                if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
                return key === "before"
                  ? Date.parse(m.createdAt) < Date.parse(value)
                  : Date.parse(m.createdAt) >= Date.parse(value);
              }
              default:
                return false;
            }
          });
          if (!matches) return [];
          const conversationName = c.dmKey
            ? [...c.members]
                .map(member)
                .map((m) => (m.kind === "person" ? m.login : m.handle))
                .join(", ")
            : "#" + c.name;
          const start = Math.max(0, text.indexOf(words[0] ?? "") - 60);
          return [
            {
              messageId: m.id,
              conversationId: c.id,
              conversationName,
              author,
              createdAt: m.createdAt,
              threadRootId: m.threadRootId,
              snippet: m.text.slice(start, start + 240),
            },
          ];
        });
        return send("ChatSearch", paged(results));
      }
      if (resource === "me" && id === "settings" && !action) {
        if (method === "GET")
          return send("ChatSettings", {
            agentWakeDefault: wakeDefaults.get(person.id) ?? "everyone",
            agentsReadMyDms: ownersAllowingDmReads.has(person.id),
          });
        if (method === "PUT") {
          const settings = parseJson(body, "ChatSettings") as ChatSettings;
          wakeDefaults.set(person.id, settings.agentWakeDefault);
          if (settings.agentsReadMyDms !== ownersAllowingDmReads.has(person.id)) {
            if (settings.agentsReadMyDms) ownersAllowingDmReads.add(person.id);
            else ownersAllowingDmReads.delete(person.id);
            for (const c of channels.values())
              if (c.dmKey && c.members.has(person.id))
                chatChange(c, {
                  kind: "conversation.updated",
                  seq: ++chatSeq,
                  refId: c.id,
                  conversationId: c.id,
                });
          }
          return send("ChatSettings", settings);
        }
      }
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
        const items = rows.slice(0, limit).map(({ value }) =>
          "messageId" in value
            ? {
                kind: value.kind,
                seq: value.seq,
                message: messageView(messageFor(value.messageId), person.id),
              }
            : value,
        );
        return send("ChatChanges", {
          items,
          nextSeq: rows.length > limit ? items.at(-1)?.seq : chatSeq,
          resync: Number(after) > chatSeq,
        });
      }
      const deny = (code: ErrorCode, rule: string, c?: Channel, handle?: string): never => {
        throw new RelayError(
          code,
          "Refused for " + person.login + " (" + roleOf(person).name + "): " + rule,
          {
            account: account(person),
            rule,
            ...(c && { conversationId: c.id }),
            ...(handle && { asHandle: handle, owner: personRef(person) }),
          },
        );
      };
      const changed = (c: Channel, kind: "request.updated" | "access.updated", refId: string) => {
        chatChange(c, { kind, refId, conversationId: c.id, seq: ++chatSeq });
        for (const viewer of people.values())
          if (!viewer.removed && rights(c, viewer).manage)
            emit(
              "needs.changed",
              "NeedsChangedEvent",
              { at: iso(Date.now()), count: personalNeeds(viewer).length },
              viewer.id,
            );
      };
      if (resource === "requests") {
        const r = requests.get(id),
          c = r && channels.get(r.conversationId);
        if (!c || !r || (r.requester.id !== person.id && !rights(c, person).manage))
          throw new RelayError("not_found", "Unknown request.");
        if (r.state !== "pending")
          throw new RelayError("chat_request_closed", "This request is " + r.state + ".", {
            closedBy: r.closedBy,
          });
        if (method === "DELETE" && !action && r.requester.id === person.id) r.state = "cancelled";
        else if (
          method === "POST" &&
          rights(c, person).manage &&
          (action === "approve" || action === "decline")
        ) {
          if (action === "approve" && c.members.size >= maxMembers)
            throw new RelayError("capacity", "Channel is full.");
          r.state = action === "approve" ? "approved" : "declined";
          if (r.state === "approved") c.members.add(r.requester.id);
          else declinedAt.set(cursorKey(r.requester.id, c.id), Date.now());
        } else deny("chat_manage_restricted", "Only managers decide requests.", c);
        r.closedBy = personRef(person);
        changed(c, "request.updated", r.id);
        return send("ChatJoinRequest", r);
      }
      if (resource === "directory" && method === "GET")
        return send(
          "ChatConversations",
          paged(
            [...channels.values()]
              .filter(
                (c) =>
                  !c.dmKey &&
                  !c.members.has(person.id) &&
                  (visible(c, person.id) || has(person, "channels.directoryAll")),
              )
              .map((c) => channelView(c, person)),
          ),
        );
      if (resource === "conversations" && !id) {
        if (method === "GET")
          return send(
            "ChatConversations",
            paged([...channels.values()].filter(canRead).map((c) => channelView(c, person))),
          );
        if (method === "POST") {
          const input = parseJson(body, "ChatCreate") as ChatCreate;
          if (input.kind === "dm") {
            const members = new Set([person.id, ...input.members]);
            if (
              members.size < 2 ||
              members.size > 8 ||
              [...members].some(
                (id) => !handles.has(id) && (!people.has(id) || people.get(id)?.removed),
              ) ||
              ([...members].some((id) => handles.has(id)) && members.size !== 2)
            )
              throw new RelayError("malformed", "Choose two to eight staff members.");
            if (!dmAllowed(person, members))
              deny("chat_dm_restricted", "The participants cannot start this DM.");
            const dmKey = JSON.stringify([...members].sort());
            const existing = [...channels.values()].find((c) => c.dmKey === dmKey);
            if (existing) return send("ChatConversation", channelView(existing, person));
            const c: Channel = {
              dmKey,
              id: randomId("c"),
              name: "",
              purpose: "",
              access: channelAccess("private"),
              managers: new Set(),
              agents: [...members].some((id) => handles.has(id)) ? "allowed" : "off",
              archived: false,
              members,
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
          if (channels.size >= 500) throw new RelayError("malformed", "Channel limit reached.");
          if ([...channels.values()].some((c) => c.name === input.name))
            throw new RelayError("malformed", "This channel name is taken.");
          const access = input.access ?? channelAccess(input.template);
          if (
            !has(
              person,
              access.visibility === "public" ? "channels.createPublic" : "channels.createPrivate",
            ) ||
            (access.outsiders !== "none" && !has(person, "channels.openToOutside"))
          )
            deny("role_permission_missing", "This role cannot create that channel.");
          const managers = new Set([person.id, ...(input.managers ?? []).map((m) => m.id)]);
          for (const id of managers) {
            const target = people.get(id);
            if (!target || target.removed || !peopleAllowed(person, id))
              throw new RelayError("not_found", "Unknown manager.");
            if (target.admission === "outside" && access.outsiders === "none")
              deny("chat_outsiders_not_allowed", "This channel does not allow outsiders.");
          }
          const c: Channel = {
            ...input,
            access,
            managers,
            agents:
              input.agents ??
              (input.template === "announcement"
                ? "off"
                : ["community", "shared"].includes(input.template ?? "")
                  ? "mentions_only"
                  : "allowed"),
            purpose: input.purpose ?? "",
            id: "c_" + NodeCrypto.randomUUID(),
            members: new Set(managers),
            archived: false,
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
        const candidate = channels.get(id);
        const directoryManager =
          candidate &&
          !visible(candidate, person.id) &&
          !candidate.dmKey &&
          has(person, "channels.directoryAll") &&
          rights(candidate, person).manage &&
          !reader &&
          ((!action && method === "PATCH") ||
            (action === "members" && memberId === person.id && method === "PUT"));
        const c = directoryManager ? candidate : channelFor(id);
        if (reader && (action !== "messages" || method !== "GET"))
          throw new RelayError("forbidden", "Choose a conversation to read.");
        if (c.dmKey && method !== "GET")
          throw new RelayError("forbidden", "DM participants are fixed.");
        if (action === "requests") {
          if (method === "GET" && rights(c, person).manage)
            return send(
              "ChatJoinRequests",
              paged(
                [...requests.values()].filter(
                  (r) => r.conversationId === id && r.state === "pending",
                ),
              ),
            );
          if (method !== "POST" || !rights(c, person).request)
            deny("chat_manage_restricted", "This request is unavailable.", c);
          const input = parseJson(body, "ChatRequestInput") as { note?: string };
          const existing = pendingRequest(c, person);
          if (existing) return send("ChatJoinRequest", existing);
          const last = declinedAt.get(cursorKey(person.id, c.id));
          if (
            (last && Date.now() - last < declineCooldown) ||
            [...requests.values()].filter(
              (r) => r.requester.id === person.id && r.state === "pending",
            ).length >= maxPending
          )
            throw new RelayError("rate_limited", "Try again after the request limit clears.");
          const row: JoinRequest = {
            id: randomId("r"),
            conversationId: id,
            requester: personRef(person),
            createdAt: iso(Date.now()),
            state: "pending",
            ...input,
          };
          requests.set(row.id, row);
          changed(c, "request.updated", row.id);
          return send("ChatJoinRequest", row);
        }
        if (action === "managers" && memberId && (method === "PUT" || method === "DELETE")) {
          if (!rights(c, person).manage)
            deny("chat_manage_restricted", "Only managers change channel managers.", c);
          if (!people.has(memberId) || !c.members.has(memberId))
            throw new RelayError("not_found", "Unknown channel member.");
          if (method === "PUT") c.managers.add(memberId);
          else if (c.managers.has(memberId) && c.managers.size === 1)
            deny("chat_manage_restricted", "Keep one channel manager.", c);
          else c.managers.delete(memberId);
          changed(c, "access.updated", id);
          response.writeHead(204).end();
          return;
        }
        if (action === "settings" && method === "PUT") {
          if (!c.members.has(person.id))
            throw new RelayError("forbidden", "Join the channel first.");
          const settings = parseJson(body, "ChatNotifications") as ChatNotifications;
          preferences.set(cursorKey(person.id, c.id), settings);
          chatChange(
            c,
            { kind: "settings.updated", seq: ++chatSeq, refId: id, conversationId: id },
            person.id,
          );
          return send("ChatNotifications", settings);
        }
        if (!action && method === "PATCH") {
          if (!rights(c, person).manage)
            deny("chat_manage_restricted", "Only managers can change these settings.", c);
          const patch = parseJson(body, "ChatPatch") as ChatPatch;
          if (
            patch.name &&
            [...channels.values()].some((other) => other.id !== id && other.name === patch.name)
          )
            throw new RelayError("malformed", "This channel name is taken.");
          if (
            defaultChannels.includes(c) &&
            ((patch.name && patch.name !== c.name) ||
              patch.archived ||
              patch.access?.visibility === "private")
          )
            throw new RelayError("forbidden", "Default channels must remain available.");
          const { managers, ...settings } = patch;
          if (
            settings.access &&
            settings.access.outsiders !== c.access.outsiders &&
            !rights(c, person).openToOutside
          )
            deny(
              "role_permission_missing",
              "Changing outside access requires channels.openToOutside.",
              c,
            );
          if (
            managers &&
            (!managers.length || managers.some((m) => !people.has(m.id) || !c.members.has(m.id)))
          )
            throw new RelayError("malformed", "Choose channel members as managers.");
          if (managers) c.managers = new Set(managers.map((m) => m.id));
          if (settings.access?.outsiders === "none" && c.access.outsiders !== "none") {
            const removed = [...c.members].filter((id) => people.get(id)?.admission === "outside");
            for (const id of removed) {
              c.members.delete(id);
              c.managers.delete(id);
            }
            if (removed.length)
              systemMessage(
                c,
                undefined,
                "outside_access_closed",
                removed.length + " outside collaborators removed.",
              );
          }
          Object.assign(c, settings);
          settleRequests();
          snapshotHeads.clear();
          chatChange(c, {
            kind: patch.access || managers ? "access.updated" : "conversation.updated",
            seq: ++chatSeq,
            refId: id,
            conversationId: id,
          });
          return send("ChatConversation", channelView(c, person));
        }
        if (action === "members") {
          if (!memberId && method === "GET")
            return send("ChatMembers", paged([...c.members].map(member)));
          if (memberId && (method === "PUT" || method === "DELETE")) {
            const self = memberId === person.id,
              can = rights(c, person);
            if (
              method === "PUT" &&
              !(self ? can.join || directoryManager || c.members.has(person.id) : can.invite)
            )
              deny("chat_invite_restricted", "The channel rules do not allow this addition.", c);
            if (!self && method === "DELETE" && !can.manage)
              deny("chat_manage_restricted", "Only managers remove members.", c);
            if (method === "PUT" && people.get(memberId)?.admission === "outside") {
              if (c.access.outsiders === "none")
                deny(
                  "chat_outsiders_not_allowed",
                  "This channel does not allow outside collaborators.",
                  c,
                );
              if (!self && !can.manage)
                deny("chat_invite_restricted", "Only managers add outside collaborators.", c);
            }
            if (method === "DELETE" && c.managers.has(memberId) && c.managers.size === 1)
              deny("chat_manage_restricted", "Keep one manager.", c);
            if (
              handles.has(memberId)
                ? owned(memberId).view.owner.id !== person.id
                : !people.has(memberId) || people.get(memberId)?.removed
            )
              throw new RelayError("not_found", "Unknown person.");
            if (method === "PUT" && c.members.size >= maxMembers && !c.members.has(memberId))
              throw new RelayError("malformed", "Channel member limit reached.");
            const targetPerson = people.get(memberId);
            if (
              method === "DELETE" &&
              defaultChannels.includes(c) &&
              targetPerson?.admission === "member" &&
              has(targetPerson, "channels.seePublic")
            )
              throw new RelayError("forbidden", "All staff belong to default channels.");
            if (method === "PUT") c.members.add(memberId);
            else {
              c.members.delete(memberId);
              c.managers.delete(memberId);
            }
            snapshotHeads.clear();
            settleRequests();
            if (directoryManager)
              systemMessage(c, undefined, "member_joined", person.login + " joined.");
            chatChange(c, {
              kind: method === "PUT" ? "member.added" : "member.removed",
              seq: ++chatSeq,
              conversationId: id,
              refId: memberId,
            });
            if (method === "PUT")
              return send("ChatMembership", {
                addedBy: personRef(person),
                member: member(memberId),
              });
            response.writeHead(204).end();
            return;
          }
        }
        if (action === "messages" && method === "GET") {
          let rows = [...messages.values()]
            .filter((m) => m.conversationId === id && !m.threadRootId)
            .reverse();
          if (reader) rows.reverse();
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
          return send("ChatMessages", paged(rows.map((m) => messageView(m, person.id))));
        }
      }
      if (resource === "threads" && id && !action && method === "GET") {
        const root = messages.get(id);
        if (!root || !canReadThread(channels.get(root.conversationId)!, id))
          throw new RelayError("not_found", "Unknown thread.");
        if (root.threadRootId)
          throw new RelayError("malformed", "A reply cannot be a thread root.");
        return send("ChatThread", {
          root: messageView(root, person.id),
          ...paged(
            [...messages.values()]
              .filter((m) => m.threadRootId === id)
              .map((m) => messageView(m, person.id)),
          ),
        });
      }
      if (
        (resource === "threads" &&
          action === "task" &&
          (method === "PUT" || method === "DELETE")) ||
        (resource === "tasks" && action === "thread" && method === "PUT")
      ) {
        const root = resource === "threads" ? messageFor(id) : undefined;
        if (root) {
          const channel = channelFor(root.conversationId);
          if (root.threadRootId || root.deleted)
            throw new RelayError("malformed", "Choose a current thread root.");
          if (!channel.members.has(person.id) || channel.archived)
            throw new RelayError("forbidden", "Join an open channel to link a task.");
        }
        const linked = root && [...taskThreads].find(([, messageId]) => messageId === id)?.[0];
        if (method === "DELETE") {
          if (linked && root) {
            taskThreads.delete(linked);
            const { taskRef: _task, ...updated } = root;
            messages.set(id, updated);
            chatChange(channelFor(root.conversationId), {
              kind: "message.edited",
              seq: ++chatSeq,
              message: updated,
            });
          }
          response.writeHead(204).end();
          return;
        }
        const taskId = root ? (parseJson(body, "ChatTask") as ChatTask).taskRef : id;
        const task = boardTasks.find((t) => t.id === taskId);
        if (!task) throw new RelayError("not_found", "Unknown board task.");
        const existing = taskThreads.get(taskId);
        let destination = existing ? messageFor(existing) : root;
        if (!existing) {
          if (linked) throw new RelayError("malformed", "Unlink this thread first.");
          if (root) {
            const updated = { ...root, taskRef: taskId };
            messages.set(id, updated);
            chatChange(channelFor(root.conversationId), {
              kind: "message.edited",
              seq: ++chatSeq,
              message: updated,
            });
          } else {
            const channel = defaultChannels[0];
            if (!channel || channel.archived || channel.access.visibility === "private")
              throw new RelayError("forbidden", "No public discussion channel is available.");
            destination = systemMessage(channel, taskId, "task_linked", task.title);
          }
          taskThreads.set(taskId, destination!.id);
        }
        return send("ChatThreadLocation", {
          conversationId: destination!.conversationId,
          threadRootId: destination!.id,
        });
      }
      const explicitAnswer = resource === "asks" && action === "answer" && method === "POST";
      if ((resource === "messages" && !id && method === "POST") || explicitAnswer) {
        const question = explicitAnswer
          ? [...messages.values()].find((m) => m.ask?.id === id)
          : undefined;
        let post: ChatPost;
        if (explicitAnswer) {
          if (!question?.ask || question.deleted)
            throw new RelayError("not_found", "Unknown question.");
          channelFor(question.conversationId);
          if (question.ask.to.id !== person.id)
            throw new RelayError("forbidden", "This question is addressed to someone else.");
          const answer = parseJson(body, "ChatAnswer") as ChatAnswer;
          const text = "choice" in answer ? answer.choice : answer.text;
          if (!text.trim() || ("choice" in answer && !question.ask.choices.includes(text)))
            throw new RelayError("malformed", "Choose an offered option or enter an answer.");
          if (question.ask.state !== "open")
            throw new RelayError("malformed", "This question is closed.");
          post = {
            conversationId: question.conversationId,
            threadRootId: question.threadRootId ?? question.id,
            text,
            key: randomId("k"),
          };
        } else post = parseJson(body, "ChatPost") as ChatPost;
        const h = post.asHandle ? owned(post.asHandle) : undefined;
        const c = channelFor(post.conversationId);
        const can = rights(c, person);
        if (!can[post.threadRootId ? "reply" : "post"])
          deny(
            c.dmKey
              ? "chat_dm_restricted"
              : c.members.has(person.id)
                ? "chat_post_restricted"
                : "chat_not_member",
            "Your account cannot post here.",
            c,
            post.asHandle,
          );
        if (
          h &&
          ((!post.threadRootId && c.access.post === "managers") ||
            (c.agents === "mentions_only" &&
              post.threadRootId &&
              ![...messages.values()].some(
                (m) =>
                  (m.threadRootId ?? m.id) === post.threadRootId &&
                  m.mentions.some((t) => t.id === h.view.id),
              )))
        )
          deny("chat_agent_capped", "This agent cannot post here.", c, h.view.id);
        if (
          !c ||
          c.archived ||
          (explicitAnswer && c.agents === "off") ||
          (h
            ? c.agents === "off" ||
              (c.access.visibility === "private" &&
                !c.members.has(h.view.id) &&
                !(post.threadRootId && follows.get(post.threadRootId)?.has(h.view.id)))
            : !explicitAnswer && !c.members.has(person.id))
        )
          throw new RelayError("forbidden", "Cannot post in this channel.");
        const actor = h?.view.id ?? person.id;
        const key = JSON.stringify([actor, post.key]);
        const previous = postKeys.get(key);
        if (previous) {
          const existing = messages.get(previous)!;
          if (existing.conversationId !== c.id)
            throw new RelayError("malformed", "Post key belongs to another channel.");
          return send("ChatMessage", existing);
        }
        const root = post.threadRootId ? messages.get(post.threadRootId) : undefined;
        if (post.threadRootId && !root) throw new RelayError("not_found", "Unknown thread.");
        if (root && (root.threadRootId || root.conversationId !== c.id))
          throw new RelayError("malformed", "Choose a root in this channel.");
        const mentions = messageMentions(post.text, post.card);
        if (
          mentions.some(
            (t) => t.kind === "agent" && handles.get(t.id)?.view.owner.id !== person.id,
          ) &&
          !has(person, "agents.mention")
        )
          deny("role_permission_missing", "Mentioning agents requires agents.mention.", c);
        if (
          (h && /@(channel|here)\b/.test(post.text)) ||
          (c.agents === "off" && mentions.some((t) => t.kind === "agent"))
        )
          throw new RelayError(
            "forbidden",
            "Agents cannot broadcast or post in a channel with agents off.",
          );
        const targets = mentions.filter((t) => t.kind === "agent");
        if (h && c.agents === "mentions_only" && !(root && follows.get(root.id)?.has(h.view.id)))
          throw new RelayError(
            "forbidden",
            "This channel is mentions-only for agents. Ask your owner to mention you.",
          );
        if (h && root && targets.length) {
          const hops = agentHops.get(root.id) ?? 0;
          if (hops >= 4)
            throw new RelayError("rate_limited", "Ask a person to continue this thread.");
          const keys = targets.map((t) => JSON.stringify([root.id, ...[t.id, h.view.id].sort()]));
          const now = Date.now();
          for (const key of keys)
            if ((pairWrites.get(key) ?? []).filter((t) => now - t < 60000).length >= 20)
              throw new RelayError("rate_limited", "Wait before mentioning this agent again.");
          for (const key of keys)
            pairWrites.set(key, [
              ...(pairWrites.get(key) ?? []).filter((t) => now - t < 60000),
              now,
            ]);
          agentHops.set(root.id, hops + 1);
        } else if (!h && root) agentHops.delete(root.id);
        const { key: _key, asHandle: _asHandle, ...fields } = post;
        const m: ChatMessage = {
          ...fields,
          id: "m_" + NodeCrypto.randomUUID(),
          seq: ++chatSeq,
          kind: "text",
          author: h
            ? {
                kind: "agent",
                id: actor,
                handle: label(h.view),
                ownerLogin: person.login,
                provider: h.view.provider,
              }
            : { kind: "person", id: person.id, login: person.login },
          mentions,
          replyCount: 0,
          reactions: [],
          createdAt: iso(Date.now()),
          deleted: false,
        };
        messages.set(m.id, m);
        const answered = new Set<string>();
        const edits: ChatMessage[] = [];
        if (!h && root) {
          for (const question of messages.values()) {
            if (
              (explicitAnswer && question.ask?.id !== id) ||
              question.deleted ||
              question.author.kind !== "agent" ||
              question.ask?.state !== "open" ||
              question.ask.to.id !== person.id ||
              (question.threadRootId ?? question.id) !== root.id
            )
              continue;
            const updated = {
              ...question,
              ask: { ...question.ask, state: "answered" as const, answerMessageId: m.id },
            };
            messages.set(question.id, updated);
            edits.push(updated);
            answered.add(question.author.id);
          }
        }
        const subscribers = follows.get(root?.id ?? m.id) ?? new Set<string>();
        for (const [hid, target] of handles) {
          if (
            hid === actor ||
            c.agents === "off" ||
            (!visible(c, target.view.owner.id) && !(c.dmKey && c.members.has(hid)))
          )
            continue;
          const reason = answered.has(hid)
            ? "answer"
            : mentions.some((t) => t.id === hid)
              ? "mention"
              : !h && c.dmKey && c.members.has(hid)
                ? "dm"
                : !h && root && subscribers.has(hid)
                  ? "follow"
                  : undefined;
          if (!reason) continue;
          const fromOwner = !h && target.view.owner.id === person.id;
          const wakes =
            target.view.wake !== "nobody" &&
            (fromOwner ||
              (target.view.wake === "everyone" &&
                person.admission !== "outside" &&
                has(person, "agents.wakeOthers")));
          const row: ChatDelivery = {
            wakes,
            id: randomId("d"),
            handleId: hid,
            messageId: m.id,
            machineId: target.view.machine.id,
            reason,
            fromOwner: !h && target.view.owner.id === person.id,
            state: "pending",
            expiresAt: iso(Date.now() + (wakes ? deliveryLifetime : inboxLifetime)),
            threadRef: target.threadRef,
            wake: target.view.wake,
            message: m,
          };
          deliveries.set(row.id, { row, claimedAt: 0 });
          if (!wakes)
            emit(
              "needs.changed",
              "NeedsChangedEvent",
              {
                at: row.message.createdAt,
                count: personalNeeds(people.get(target.view.owner.id)!).length,
              },
              target.view.owner.id,
            );
          for (const stream of streams)
            if (wakes && stream.machineId === row.machineId)
              stream.response.write(
                "event: chat.delivery\ndata: " +
                  JSON.stringify({ deliveryId: row.id, handleId: hid }) +
                  "\n\n",
              );
        }
        subscribers.add(actor);
        for (const mention of mentions) subscribers.add(mention.id);
        follows.set(root?.id ?? m.id, subscribers);
        postKeys.set(key, m.id);
        if (root)
          messages.set(root.id, {
            ...messages.get(root.id)!,
            replyCount: root.replyCount + 1,
            lastReplyAt: m.createdAt,
          });
        chatChange(c, { kind: "message.created", seq: m.seq, message: m });
        for (const updated of edits)
          chatChange(c, { kind: "message.edited", seq: ++chatSeq, message: updated });
        return explicitAnswer
          ? send("ChatAsk", messages.get(question!.id)!.ask)
          : send("ChatMessage", m);
      }
      if (resource === "messages" && id && !action && (method === "PATCH" || method === "DELETE")) {
        const m = messageFor(id);
        if (
          (m.author.kind !== "person" || m.author.id !== person.id) &&
          !(method === "DELETE" && has(person, "relay.admin"))
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
        if (!input) {
          reactions.delete(id);
          if (m.threadRootId) {
            const root = messages.get(m.threadRootId)!;
            const { lastReplyAt: _last, ...parent } = root;
            const replies = [...messages.values()].filter(
              (reply) => reply.threadRootId === root.id && !reply.deleted && reply.id !== id,
            );
            const last = replies.at(-1);
            messages.set(root.id, {
              ...parent,
              replyCount: replies.length,
              ...(last && { lastReplyAt: last.createdAt }),
            });
          }
          if (m.taskRef && taskThreads.get(m.taskRef) === id) taskThreads.delete(m.taskRef);
        }
        messages.set(id, edited);
        chatChange(channelFor(m.conversationId), {
          kind: input ? "message.edited" : "message.deleted",
          seq: ++chatSeq,
          message: edited,
        });
        return send("ChatMessage", messageView(edited, person.id));
      }
      if (
        resource === "threads" &&
        action === "follow" &&
        (method === "DELETE" || method === "PUT")
      ) {
        const root = messageFor(id);
        if (root.threadRootId) throw new RelayError("malformed", "Choose the thread root.");
        const ids = follows.get(id) ?? new Set<string>();
        if (method === "PUT") ids.add(person.id);
        else ids.delete(person.id);
        follows.set(id, ids);
        response.writeHead(204).end();
        return;
      }
      if (
        resource === "messages" &&
        action === "reactions" &&
        memberId &&
        (method === "PUT" || method === "DELETE")
      ) {
        const m = messages.get(id),
          c = m && channels.get(m.conversationId);
        if (
          !m ||
          !c ||
          !(canRead(c) || (reader && follows.get(m.threadRootId ?? m.id)?.has(reader.view.id)))
        )
          throw new RelayError("not_found", "Unknown message.");
        const actor = reader?.view.id ?? person.id;
        if (
          m.deleted ||
          (!c.members.has(actor) &&
            !(
              reader &&
              (c.access.visibility === "public" || follows.get(m.threadRootId ?? m.id)?.has(actor))
            ))
        )
          throw new RelayError("forbidden", "Cannot react to this message.");
        const emoji = decodeURIComponent(memberId);
        const counts = reactions.get(id) ?? new Map<string, Set<string>>();
        const ids = counts.get(emoji) ?? new Set<string>();
        if (method === "PUT") ids.add(actor);
        else ids.delete(actor);
        if (ids.size) counts.set(emoji, ids);
        else counts.delete(emoji);
        reactions.set(id, counts);
        chatChange(c, { kind: "reaction", seq: ++chatSeq, refId: id, conversationId: c.id });
        return send("ChatMessage", messageView(m, person.id));
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

    if (route.startsWith("/team/")) {
      if (!has(caller.person, "hub.team")) throw new RelayError("not_found", "Team unavailable.");
      const roomPath = /^\/team\/rooms\/([^/]+)(\/sessions)?$/.exec(route);
      const board = roomPath?.[1];
      if (board && (!boardAllowed(caller.person, board) || !boards.some((b) => b.id === board)))
        throw new RelayError("not_found", "Unknown room.");
      const broadcast = (event: string, data: unknown) => {
        for (const stream of streams)
          if (
            has(people.get(stream.personId)!, "hub.team") &&
            peopleAllowed(people.get(stream.personId)!, caller.person.id) &&
            (!board || boardAllowed(people.get(stream.personId)!, board))
          )
            stream.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      if (method === "PUT" && route === "/team/me") {
        const id = caller.person.id;
        const edit = parseJson(body, "TeamEdit") as TeamPresenceEdit;
        const current = presence.get(id) ?? { presence: "off" };
        const needsClear =
          current.seatBoard &&
          edit.seatBoard === undefined &&
          !teamSessions(caller.person).some(
            (r) => r.session.personId === id && r.board === current.seatBoard,
          ) &&
          !boardTasks.some(
            (t) => t.board === current.seatBoard && leaseOf(t, Date.now())?.holder.id === id,
          );
        const next = editPresence(current, needsClear ? { ...edit, seatBoard: null } : edit);
        presence.set(id, next);
        broadcast("team.changed", { person: { id, ...next } });
        return sendJson(response, 200, "TeamPresence", { id, ...next });
      }
      if (method === "PUT" && (route === "/team/office" || (board && !roomPath?.[2]))) {
        if (!has(caller.person, "relay.admin"))
          throw new RelayError("forbidden", "Only founders can set meeting links.");
        const { meetingUrl } = parseJson(body, "TeamMeeting") as { meetingUrl: string | null };
        if (meetingUrl === null) meetings.delete(board ?? "");
        else meetings.set(board ?? "", meetingUrl);
        broadcast("team.rooms_changed", {});
        response.writeHead(204);
        response.end();
        return;
      }
      if (method === "GET" && route === "/team/heartbeats") {
        const ids = query.get("sessions")?.split(",") ?? [];
        if (!ids.length || ids.length > 50 || ids.some((id) => !ID_PATTERN.test(id)))
          throw new RelayError("malformed", "Choose 1 to 50 session ids.");
        const visible = new Map(teamSessions(caller.person).map((r) => [r.session.id, r.heardAt]));
        const sessions = [...new Set(ids)].flatMap((id) => {
          const heardAt = visible.get(id);
          return heardAt === undefined ? [] : [{ id, heardAt: iso(heardAt) }];
        });
        return sendJson(response, 200, "TeamHeartbeats", { asOf: iso(Date.now()), sessions });
      }
      if (method === "GET") {
        const { offset, limit } = pageParams(query);
        const count = query.has("limit") ? limit : 100;
        if (route === "/team/agents") {
          const summary = teamSummary(
            caller.person,
            teamPeople(caller.person),
            teamSessions(caller.person),
          );
          return sendJson(
            response,
            200,
            "TeamAgentsPage",
            teamPage("agents", summary.agents, offset, count, 65536),
          );
        }
        if (route === "/team/people") {
          const q = (query.get("q") ?? "").toLowerCase();
          const rows = teamPeople(caller.person).filter(
            (p) =>
              p.login.toLowerCase().startsWith(q) || p.displayName?.toLowerCase().startsWith(q),
          );
          return sendJson(
            response,
            200,
            "SnapshotTeamPeople",
            teamPage("people", rows, offset, count, 160 * 1024),
          );
        }
        if (route === "/team/hallway/sessions" || roomPath?.[2]) {
          const rows = teamSessions(caller.person)
            .filter((r) => r.board === board)
            .map((r) => r.session);
          return sendJson(
            response,
            200,
            "SnapshotTeamRoom",
            teamPage("sessions", rows, offset, count, 96 * 1024),
          );
        }
      }
      throw new RelayError("not_found", "Unknown Team call.");
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
      const canRevoke = target?.personId === caller.person.id || has(caller.person, "relay.admin");
      if (
        !target ||
        (!canRevoke && (!has(caller.person, "hub.machinesAll") || !visibleToColleagues(target)))
      ) {
        throw new RelayError("not_found", "No such machine.");
      }
      if (!canRevoke) {
        throw new RelayError("forbidden", "Only the machine's owner or a founder may revoke it.");
      }
      if (target.revokedAt === null) revokeMachine(target);
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
      const reported = new Set(facts.activity.map((f) => f.sessionId));
      const retained = caller.machine.sessions.filter(
        (f) =>
          f.state === "stopped" &&
          !reported.has(f.sessionId) &&
          Date.now() - (caller.machine.teamStates.get(f.sessionId)?.since ?? 0) < 3600000,
      );
      caller.machine.sessions = [...facts.activity, ...retained];
      caller.machine.teamStates = nextTeamStates(
        caller.machine.teamStates,
        caller.machine.sessions,
      );
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
      sendJson(response, 200, "RepositoriesPage", page(reposFor(caller.person), offset, limit));
      return;
    }

    if (method === "GET" && (route === "/feed" || route === "/graveyard")) {
      const { offset, limit } = pageParams(query);
      const records = (route === "/feed" ? feedRecords : graveyardRecords).filter((r) =>
        recordAllowed(caller.person, r.taskId),
      );
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
      if (found === undefined || !taskAllowed(caller.person, found))
        throw new RelayError("not_found", "No such task.");
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
      const gzip = (request.headers["accept-encoding"] ?? "").split(",").some((coding) => {
        const [name, weight] = coding
          .trim()
          .split(";")
          .map((token) => token.trim());
        return name === "gzip" && (!weight || Number(weight.replace(/^q=/, "")) > 0);
      });
      response.writeHead(200, {
        vary: "Accept-Encoding",
        ...(gzip && { "content-encoding": "gzip" }),
        "content-type": "application/json",
        etag: `"sha256:${hex}"`,
        "cache-control": "private, max-age=31536000, immutable",
      });
      response.end(gzip ? NodeZlib.gzipSync(bytes) : bytes);
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
              ? refusePairing(
                  pairingId,
                  input.reason as Refusal,
                  typeof input.login === "string" ? input.login : undefined,
                )
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
      const comments = seedComments(input.comments, now, task.tracker.comments.length);
      task.tracker.comments.push(...comments);
      if (input.assignees !== undefined)
        task.tracker.assignees = seedNames(input.assignees, "assignees");
      if (input.labels !== undefined) task.tracker.labels = seedNames(input.labels, "labels");
      feedReleases(task);
      if (taskThreads.has(task.id) && comments.length) {
        const fresh = new Set(comments);
        foldTracker(task.tracker, now, (comment, holder, release) => {
          if (!fresh.has(comment)) return;
          if (release) {
            const reason = release.reasonText ?? REASON_WORDS[release.reason] ?? release.reason;
            echoLease(
              task,
              release.reason === "handing_over" ? "lease_handed_over" : "lease_released",
              release.by + " released the task: " + reason + ".",
            );
          } else echoLease(task, "lease_taken", holder + " took the task.");
        });
      }
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
      const ignoredReason = has(checker, "relay.admin")
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
    if (request.method === "POST" && route === "/outside/check") {
      const person = peopleByLogin.get(String(input.login));
      if (!person || person.admission !== "outside")
        throw new RelayError("not_found", "Unknown outside collaborator.");
      const reason = input.reason;
      if (reason === null) delete person.outsideReason;
      else if (
        [
          "outside_check_pending",
          "outside_grant_lost",
          "outside_entry_removed",
          "outside_2fa_off",
          "outside_identity_mismatch",
        ].includes(String(reason))
      ) {
        person.outsideReason = reason as OutsideReason;
        closeStreams((stream) => stream.personId === person.id);
        if (reason !== "outside_check_pending") removeStaff(person.login);
      } else throw new RelayError("malformed", "Unknown outside check result.");
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

  if (options.officeFixture) {
    const company = options.officeFixture === "company";
    boards = Array.from({ length: 50 }, (_, i) => ({
      id: "board-" + String(i + 1).padStart(2, "0"),
      title: "Board " + (i + 1),
    }));
    for (let i = 0; i < (company ? 500 : 2000); i++) {
      const person = personFor(
        i === 0 ? defaultPerson : { login: "builder-" + String(i).padStart(4, "0") },
      );
      if (!company) continue;
      const board = boards[Math.floor(i / 10)]!.id;
      presence.set(person.id, { presence: "available", seatBoard: board });
      for (const provider of ["codex", "claude", "cursor"])
        fixtureSessions.push({
          board,
          heardAt: startedAt,
          session: {
            id: "s_" + i + "_" + provider,
            personId: person.id,
            provider,
            state: "working",
            since: iso(startedAt),
          },
        });
    }
  }
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
