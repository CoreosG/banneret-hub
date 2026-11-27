import { RelayMe } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - node:os machine facts and node:crypto seed and digest are synchronous.
// Banneret Hub: this environment's enrolments in company relays. One enrolment per relay origin, so
// a machine can join several companies; each relay is its own instance of the machine below, with
// its own state file (stateDir/banneret/relays/<hash>.json), secrets (suffixed by the same hash),
// driver fiber, counter and heartbeat. The relays never share state, so one relay's crash window
// cannot touch another's files.
// The persisted state is one of six values (see the state table in the PR that added this file);
// health is run-time only. Writes go secrets first, then the state file; removals go state file
// first, then secrets, and start-up deletes secrets that no state matches. A relay's state file is
// written (as `none`) before its first secret, so every secret has a state file to match.
//
// Token re-issue (relay v1, README "Enrolment" step 6): until a token is used, every poll of an
// approved pairing returns a fresh token and the one before it stops working. So `approved` keeps
// `pairingId` (the key is the machine key and stays anyway) until the first signed call succeeds;
// `configured` drops it.
//
// | From                         | Event                                              | To                               |
// |------------------------------|----------------------------------------------------|----------------------------------|
// | requested, awaiting_approval | poll `approved` with a token                       | approved (token written, then state) |
// | requested, awaiting_approval | poll `approved` without a token                    | none, `token_lost`               |
// | requested, awaiting_approval | poll reply lost, or crash before `approved` saved  | unchanged; the next poll brings a fresh token |
// | approved                     | signed setup calls succeed                         | configured (pairing data dropped) |
// | approved                     | 401 `unauthenticated`, then poll `approved` + token | approved, fresh token written; retry after backoff |
// | approved                     | 401 `unauthenticated`, then poll `approved`, no token | approved, health `refused`; retry after backoff |
// | approved                     | 401 `unauthenticated`, then poll `refused`/`expired`/404/other | none, as from requested |
// | approved                     | 401 `unauthenticated`, then 429/503/network        | approved; back off               |
// | approved                     | any other 401                                      | approved, health `refused`; back off |
// | approved, configured         | 401 `token_revoked`                                | revoked                          |
import * as NodeCrypto from "node:crypto";
import { readTailscaleLogin } from "./tailscaleLogin.ts";
import * as NodeOS from "node:os";

import {
  BANNERET_MACHINE_LABEL_PATTERN,
  BANNERET_RELAY_WS_METHODS,
  PoolResources,
  type OfficeEdit,
  OfficeHeartbeats,
  OfficeSharing,
  officeMeetingUrlValid,
  PoolFounderView,
  type PoolFounderAction,
  SandboxReceipt,
  type SandboxAction,
  WorkspaceReceipt,
  type WarningPolicy,
  BanneretMachineKind,
  BanneretRelayError,
  type BanneretEnrolmentMachine,
  type BanneretEnrolmentView,
  type BanneretMachineKind as MachineKind,
  type BanneretRelayHealth,
  type BanneretRelayMachinesPage,
  type BanneretRelayProbeResult,
  type BanneretWorkspace,
  parseBanneretRelayAddress,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ownResources, biggestFolders } from "../resources/OwnCgroup.ts";
import packageJson from "../../../package.json" with { type: "json" };
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as Workspaces from "../Workspaces.ts";
import { BanneretFacts, factsRequestBody } from "./Facts.ts";
import { projectKeyFromRemote } from "./projectKey.ts";
import {
  isRelayApiCall,
  notRelayApiError,
  RelayCallError,
  type RelayReply,
  relayFetch,
} from "./RelayClient.ts";
import { type BoardTaskEntry, taskIdForLinks } from "./Snapshot.ts";
import {
  type MachineKey,
  RelayCounter,
  keyFromSeed,
  rfc3339,
  sign,
  waitBeforeSigning,
} from "./RelaySigning.ts";

/** 16 hex of sha256(origin): the relay's file name, secret suffix and Enterprise workspace id. */
export const relayHash = (origin: string) =>
  NodeCrypto.createHash("sha256").update(origin).digest("hex").slice(0, 16);

/** The machine key of one relay's enrolment. */
export const keySecret = (origin: string) => `banneret-relay-key-${relayHash(origin)}`;
/** The device token of one relay's enrolment. */
export const tokenSecret = (origin: string) => `banneret-relay-token-${relayHash(origin)}`;
/** A new pairing's key while the old enrolment's key must survive until `requested` is saved. */
export const nextKeySecret = (origin: string) => `banneret-relay-key-next-${relayHash(origin)}`;

const Pending = {
  relayOrigin: Schema.String,
  displayName: Schema.String,
  pairingId: Schema.String,
  confirmCode: Schema.String,
  browserUrl: Schema.String,
  expiresAt: Schema.String,
  label: Schema.String,
  kind: BanneretMachineKind,
  startedAt: Schema.String,
};

const Persisted = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("none"),
    relayOrigin: Schema.String,
    refusedLogin: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
  Schema.Struct({ state: Schema.Literals(["requested", "awaiting_approval"]), ...Pending }),
  Schema.Struct({
    state: Schema.Literal("approved"),
    relayOrigin: Schema.String,
    displayName: Schema.String,
    /** Kept until the first signed call succeeds, to poll for a re-issued token. */
    pairingId: Schema.String,
    machineId: Schema.String,
    label: Schema.String,
    kind: BanneretMachineKind,
    startedAt: Schema.String,
    counterMark: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("configured"),
    relayOrigin: Schema.String,
    displayName: Schema.String,
    machineId: Schema.String,
    label: Schema.String,
    kind: BanneretMachineKind,
    community: Schema.optional(Schema.Boolean),
    sharing: Schema.optional(OfficeSharing),
    me: RelayMe,
    replacedLabel: Schema.optional(Schema.String),
    lastOkAt: Schema.optional(Schema.String),
    counterMark: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("revoked"),
    relayOrigin: Schema.String,
    displayName: Schema.String,
    label: Schema.String,
    reason: Schema.String,
  }),
]);
type Persisted = typeof Persisted.Type;
type PendingState = Extract<Persisted, { state: "requested" | "awaiting_approval" }>;
type Enrolled = Extract<Persisted, { state: "approved" | "configured" }>;
type Configured = Extract<Persisted, { state: "configured" }>;
type Approved = Extract<Persisted, { state: "approved" }>;

const PersistedJson = Schema.fromJsonString(Persisted);
const decodePersisted = Schema.decodeUnknownEffect(PersistedJson);
const encodePersisted = Schema.encodeEffect(PersistedJson);

const StartReply = Schema.Struct({
  pairingId: Schema.String,
  confirmCode: Schema.String,
  browserUrl: Schema.String,
  expiresAt: Schema.String,
  retryAfterMs: Schema.Number,
});
const PollReply = Schema.Struct({
  state: Schema.Literals(["pending", "awaiting_approval", "approved", "refused", "expired"]),
  expiresAt: Schema.String,
  retryAfterMs: Schema.Number,
  machineId: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  account: Schema.optional(Schema.Struct({ login: Schema.String })),
  reason: Schema.optional(Schema.String),
});
const PublicCapabilities = Schema.Struct({
  displayName: Schema.String,
  enrolment: Schema.Struct({ start: Schema.String, browser: Schema.String }),
});
const EnrolledCapabilities = Schema.Struct({
  me: RelayMe,
  team: Schema.optional(Schema.Struct({ preset: Schema.Literals(["company", "community"]) })),
});
const MachinesReply = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      environmentId: Schema.String,
      ownerId: Schema.String,
      ownerLogin: Schema.String,
      label: Schema.String,
      kind: Schema.String,
      poolHostId: Schema.optional(Schema.String),
      hostname: Schema.String,
      os: Schema.String,
      lastHeardAt: Schema.NullOr(Schema.String),
      connected: Schema.Boolean,
      revocable: Schema.optional(Schema.Boolean),
      revokedAt: Schema.optional(Schema.String),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
const RepositoriesReply = Schema.Struct({
  items: Schema.Array(Schema.Struct({ projectKey: Schema.String })),
  nextCursor: Schema.NullOr(Schema.String),
});

const FactsReply = Schema.Struct({
  capabilitiesVersion: Schema.String,
  snapshotEtag: Schema.optional(Schema.String),
});

const decodeEnrolledCapabilities = Schema.decodeUnknownOption(EnrolledCapabilities);
const decodeFactsReply = Schema.decodeUnknownOption(FactsReply);
const decodePublicCapabilities = Schema.decodeUnknownEffect(PublicCapabilities);

const decodeReply = <S extends Schema.Top>(schema: S, reply: RelayReply) =>
  Schema.decodeUnknownEffect(schema)(reply.body).pipe(
    Effect.mapError(
      () =>
        new RelayCallError({
          status: reply.status,
          code: "bad_response",
          message: "The relay's answer did not match relay v1.",
          retryable: true,
        }),
    ),
  );

/** `ent-` + the first 16 hex of sha256(origin): one Enterprise workspace per relay, on every environment. */
const enterpriseWorkspaceId = (origin: string) => `ent-${relayHash(origin)}`;

const sanitize = (
  value: string,
  pattern: RegExp,
  allowed: RegExp,
  fallback: string,
  max: number,
) => {
  const cleaned = value
    .replace(allowed, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "")
    .slice(0, max);
  return pattern.test(cleaned) ? cleaned : fallback;
};

/** The hostname and Hub version this machine reports, as the relay's `pairings list` shows them. */
const hostFacts = () => ({
  ...(/^[A-Za-z0-9_-]{1,64}$/.test(process.env.BANNERET_POOL_HOST_ID ?? "")
    ? { poolHostId: process.env.BANNERET_POOL_HOST_ID }
    : {}),
  hostname: sanitize(
    NodeOS.hostname(),
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/,
    /[^A-Za-z0-9.-]+/g,
    "hub",
    253,
  ),
  hubVersion: sanitize(
    packageJson.version,
    /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/,
    /[^0-9A-Za-z.+-]+/g,
    "0",
    64,
  ),
});

/** Machine facts for `enroll/start`, sanitised to the contract's patterns. Never a path. */
const machineFacts = (environmentId: string, label: string, kind: MachineKind) => ({
  environmentId,
  label,
  kind,
  ...hostFacts(),
  os: sanitize(
    `${NodeOS.type()} ${NodeOS.release()}`,
    /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/,
    /[^A-Za-z0-9 ._()-]+/g,
    "unknown",
    64,
  ),
  policyFingerprint: null,
  sandbox: { enabled: false, image: null },
});

export interface EnrolmentOptions {
  readonly pollFloorMs: number;
  /** The heartbeat interval while configured. */
  readonly healthIntervalMs: number;
  readonly counterSaveMs: number;
  readonly maxBackoffMs: number;
  readonly maxClockWaitMs: number;
  /** Tests: runs before every durable write; a defect here stands for a crash at that step. */
  readonly beforeWrite?: (step: string) => Effect.Effect<void>;
}

const DEFAULT_OPTIONS: EnrolmentOptions = {
  pollFloorMs: 1000,
  healthIntervalMs: 30_000,
  counterSaveMs: 5000,
  maxBackoffMs: 60_000,
  maxClockWaitMs: 120_000,
};

/** One relay's enrolment: the state machine of the table above, for that relay only. */
export interface RelayEnrolment {
  readonly origin: string;
  readonly status: Effect.Effect<BanneretEnrolmentView>;
  readonly start: (input: {
    readonly origin: string;
    readonly label: string;
    readonly kind: MachineKind;
  }) => Effect.Effect<BanneretEnrolmentView, BanneretRelayError>;
  readonly cancel: Effect.Effect<BanneretEnrolmentView, BanneretRelayError>;
  readonly leave: (
    mode: "revoke" | "forget",
    keepWorkspace?: boolean,
  ) => Effect.Effect<BanneretEnrolmentView, BanneretRelayError>;
  readonly machines: (
    cursor: string | undefined,
  ) => Effect.Effect<BanneretRelayMachinesPage, BanneretRelayError>;
  readonly revokeMachine: (machineId: string) => Effect.Effect<void, BanneretRelayError>;
  readonly matchProjects: (
    remoteUrls: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, BanneretRelayError>;
  /** An effect that completes at the next change of this relay's view or files, or driver step. */
  readonly nextChange: Effect.Effect<Effect.Effect<void>>;
  /** RelayFeed seam: a signed GET, only while configured. */
  readonly signedChat: (
    method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) => Effect.Effect<RelayReply, RelayCallError>;
  readonly officeEdit: (action: OfficeEdit) => Effect.Effect<void, BanneretRelayError>;
  readonly officeHeard: (
    ids: readonly string[],
  ) => Effect.Effect<OfficeHeartbeats, BanneretRelayError>;
  readonly poolFounder: (
    action?: PoolFounderAction,
  ) => Effect.Effect<PoolFounderView, BanneretRelayError>;
  readonly sandbox: (
    action: typeof SandboxAction.Type,
  ) => Effect.Effect<typeof SandboxReceipt.Type, BanneretRelayError>;
  readonly requestWorkspace: (
    hostId: string,
  ) => Effect.Effect<typeof WorkspaceReceipt.Type, BanneretRelayError>;
  readonly signedGet: (
    target: string,
    options?: { readonly ifNoneMatch?: string; readonly maxResponseBytes?: number },
  ) => Effect.Effect<RelayReply, RelayCallError>;
  /** RelayFeed seam: the last heartbeat's `snapshotEtag` (unquoted), the hint to reread the head. */
  readonly snapshotEtag: Effect.Effect<string | undefined>;
  /** RelayFeed seam: the last heartbeat's `capabilitiesVersion`, the hint to reread capabilities. */
  readonly capabilitiesVersion: Effect.Effect<string | undefined>;
  /** RelayFeed seam: the board's tasks, so a heartbeat can name a thread's linked task. */
  readonly setBoardTasks: (tasks: ReadonlyArray<BoardTaskEntry>) => Effect.Effect<void>;
  /** RelayFeed seam: the signed headers for one GET of the event stream, only while configured. */
  readonly signStream: (
    target: string,
  ) => Effect.Effect<
    { readonly origin: string; readonly headers: Record<string, string> },
    RelayCallError
  >;
}

interface EnrolmentService {
  readonly probe: (origin: string) => Effect.Effect<BanneretRelayProbeResult, BanneretRelayError>;
  /** Every relay this environment has a state file for, in origin order. */
  readonly list: Effect.Effect<ReadonlyArray<BanneretEnrolmentView>>;
  /** What this machine tells every relay about itself, for support to match `pairings list`. */
  readonly machine: Effect.Effect<BanneretEnrolmentMachine>;
  /** One relay's view; `none` when this environment never tried that relay. */
  readonly status: (relayOrigin: string) => Effect.Effect<BanneretEnrolmentView>;
  /** One relay's instance, if this environment has one. Never creates one, so never calls a relay. */
  readonly relay: (relayOrigin: string) => Effect.Effect<RelayEnrolment | undefined>;
  readonly start: (input: {
    readonly origin: string;
    readonly label: string;
    readonly kind: MachineKind;
  }) => Effect.Effect<BanneretEnrolmentView, BanneretRelayError>;
  readonly cancel: (
    relayOrigin: string,
  ) => Effect.Effect<BanneretEnrolmentView, BanneretRelayError>;
  readonly leave: (
    relayOrigin: string,
    mode: "revoke" | "forget",
    keepWorkspace?: boolean,
  ) => Effect.Effect<BanneretEnrolmentView, BanneretRelayError>;
  readonly machines: (
    relayOrigin: string,
    cursor: string | undefined,
  ) => Effect.Effect<BanneretRelayMachinesPage, BanneretRelayError>;
  readonly revokeMachine: (
    relayOrigin: string,
    machineId: string,
  ) => Effect.Effect<void, BanneretRelayError>;
  readonly matchProjects: (
    relayOrigin: string,
    remoteUrls: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, BanneretRelayError>;
  /** An effect that completes at the next change of any relay, or when a relay is added. */
  readonly nextChange: Effect.Effect<Effect.Effect<void>>;
}

const notRunning = Effect.fail(
  new BanneretRelayError({ message: "Enterprise enrolment is not running on this server." }),
);

const notConfigured = Effect.fail(
  new RelayCallError({
    status: 0,
    code: "not_configured",
    message: "This machine has not joined a company.",
    retryable: false,
  }),
);

/** The view of a relay this environment has never tried. */
const noneView = (relayOrigin: string): BanneretEnrolmentView => ({
  state: "none",
  workspaceId: enterpriseWorkspaceId(relayOrigin),
  relayOrigin,
});

/** A relay origin as the client sent it, reduced to the form the instances are keyed by. */
const normalizeOrigin = (input: string): string | null => {
  const address = parseBanneretRelayAddress(input);
  return address.ok ? address.origin : null;
};

/**
 * A reference, not a required service: a server built without the enrolment layer (upstream's
 * ws.test.ts) answers as an environment that never enrolled, and still makes no relay call.
 */
export class BanneretEnrolment extends Context.Reference<EnrolmentService>(
  "t3/banneret/relay/Enrolment/BanneretEnrolment",
  {
    defaultValue: () => ({
      probe: () => notRunning,
      list: Effect.succeed([]),
      machine: Effect.sync(() => ({ environmentId: "", ...hostFacts() })),
      status: (relayOrigin) =>
        Effect.succeed(noneView(normalizeOrigin(relayOrigin) ?? relayOrigin)),
      relay: () => Effect.undefined,
      start: () => notRunning,
      cancel: () => notRunning,
      leave: () => notRunning,
      machines: () => notRunning,
      revokeMachine: () => notRunning,
      matchProjects: () => notRunning,
      nextChange: Effect.succeed(Effect.never),
    }),
  },
) {}

const fail = (message: string) => Effect.fail(new BanneretRelayError({ message }));

const plainFailure = (error: RelayCallError, relay: string): BanneretRelayError => {
  if (error.status === 0) return new BanneretRelayError({ message: `Cannot reach ${relay}.` });
  if (error.code === "redirect")
    return new BanneretRelayError({ message: `${relay} redirects; Banneret Hub does not follow.` });
  if (error.retryable)
    return new BanneretRelayError({ message: `${relay} is unavailable. Try again later.` });
  return new BanneretRelayError({ message: error.message });
};

const probeRelay = Effect.fn("BanneretEnrolment.probe")(function* (input: string) {
  const address = parseBanneretRelayAddress(input);
  if (!address.ok) return yield* fail(address.message);
  const reply = yield* Effect.flatMap(Clock.currentTimeMillis, (now) =>
    relayFetch({
      origin: address.origin,
      method: "GET",
      target: "/relay/v1/capabilities",
      nowMs: now,
    }),
  ).pipe(Effect.mapError((error) => plainFailure(error, address.origin)));
  const capabilities = yield* decodePublicCapabilities(reply.body).pipe(
    Effect.mapError(
      () => new BanneretRelayError({ message: "That address is not a Banneret relay." }),
    ),
  );
  if (
    capabilities.enrolment.start !== "/relay/v1/enroll/start" ||
    capabilities.displayName.length === 0 ||
    capabilities.displayName.length > 80
  ) {
    return yield* fail("That address is not a relay this version of Banneret Hub can join.");
  }
  return {
    origin: address.origin,
    displayName: capabilities.displayName,
  };
});

/** What every relay instance shares: the server's services and the layer's scope. */
interface RelayShared {
  readonly options: EnrolmentOptions;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly environmentId: string;
  readonly facts: BanneretFacts["Service"];
  readonly context: Context.Context<ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>;
  readonly clock: Clock.Clock;
  readonly relaysDir: string;
  /** The layer's scope: a relay added by a `start` call must outlive that call. */
  readonly scope: Scope.Scope;
  /** Tells the manager that this relay changed. */
  readonly changed: Effect.Effect<void>;
}

/**
 * One relay's enrolment. `loaded` is its state file's contents, or undefined for a relay this
 * environment has not tried before (no file yet; `start` writes one before any secret).
 */
const makeRelay = Effect.fn("BanneretEnrolment.makeRelay")(function* (
  shared: RelayShared,
  origin: string,
  loaded: Persisted | undefined,
) {
  const { options, fs, path, secrets, environmentId, facts, context, clock } = shared;
  const stateFile = path.join(shared.relaysDir, `${relayHash(origin)}.json`);
  const KEY_SECRET = keySecret(origin);
  const TOKEN_SECRET = tokenSecret(origin);
  const NEXT_KEY_SECRET = nextKeySecret(origin);
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  const nowMs = () => Clock.currentTimeMillis;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  let current: Persisted = { state: "none", relayOrigin: origin };
  let onDisk = loaded !== undefined;
  let health: BanneretRelayHealth | undefined;
  let unreachableSince: string | undefined;
  let etag: string | undefined;
  let snapshotEtag: string | undefined;
  let capabilitiesVersion: string | undefined;
  let boardTasks: ReadonlyArray<BoardTaskEntry> = [];
  let backoffMs = 0;
  let lastMarkSaveMs = 0;
  // The counter saved by the previous run; signed calls wait until the clock has passed it.
  let startupMark: bigint | null = null;
  let counter = new RelayCounter(() => clock.currentTimeMillisUnsafe());

  let wakeSignal = Deferred.makeUnsafe<void>();
  const wake = Effect.sync(() => {
    const signal = wakeSignal;
    wakeSignal = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(signal, Effect.void);
  });

  let changeSignal = Deferred.makeUnsafe<void>();
  const notify = Effect.sync(() => {
    const signal = changeSignal;
    changeSignal = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(signal, Effect.void);
  }).pipe(Effect.andThen(shared.changed));

  const beforeWrite = (step: string) => options.beforeWrite?.(step) ?? Effect.void;

  // Every write below runs under `lock`.
  const persist = Effect.fn("BanneretEnrolment.persist")(function* (next: Persisted) {
    yield* beforeWrite(`state:${next.state}`);
    const contents = yield* encodePersisted(next).pipe(Effect.orDie);
    const staging = `${stateFile}.staging-${process.pid}`;
    yield* fs.makeDirectory(path.dirname(stateFile), { recursive: true }).pipe(Effect.orDie);
    yield* fs.writeFileString(staging, contents).pipe(Effect.orDie);
    yield* fs.rename(staging, stateFile).pipe(Effect.orDie);
    current = next;
    onDisk = true;
    yield* notify;
  });
  const setSecret = (name: string, value: Uint8Array) =>
    beforeWrite(`set:${name}`).pipe(Effect.andThen(secrets.set(name, value)), Effect.orDie);
  const removeSecret = (name: string) =>
    beforeWrite(`remove:${name}`).pipe(Effect.andThen(secrets.remove(name)), Effect.orDie);
  const readSecret = (name: string) =>
    secrets.get(name).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
  const removeSecrets = Effect.all([removeSecret(KEY_SECRET), removeSecret(TOKEN_SECRET)], {
    discard: true,
  });

  const withWorkspaces = <A, E>(
    effect: Effect.Effect<A, E, ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>,
  ) => Effect.provideContext(effect, context);

  const putWorkspace = Effect.fn("BanneretEnrolment.putWorkspace")(function* (
    relayOrigin: string,
    displayName: string,
  ) {
    const id = enterpriseWorkspaceId(relayOrigin);
    const now = yield* nowIso;
    const existing = (yield* withWorkspaces(Workspaces.list())).workspaces.find(
      (workspace) => workspace.id === id && workspace.deleted !== true,
    );
    const workspace: BanneretWorkspace = {
      id,
      name: existing?.name ?? displayName,
      kind: "enterprise",
      projectKeys: existing?.projectKeys ?? [],
      relay: { origin: relayOrigin, displayName },
      updatedAt: now,
    };
    yield* beforeWrite("workspace");
    yield* withWorkspaces(Workspaces.put({ workspaces: [workspace] }));
  });

  const tombstoneWorkspace = Effect.fn("BanneretEnrolment.tombstoneWorkspace")(function* (
    relayOrigin: string,
  ) {
    const id = enterpriseWorkspaceId(relayOrigin);
    const existing = (yield* withWorkspaces(Workspaces.list())).workspaces.find(
      (workspace) => workspace.id === id && workspace.deleted !== true,
    );
    if (existing === undefined) return;
    const now = yield* nowIso;
    yield* beforeWrite("workspace");
    yield* withWorkspaces(
      Workspaces.put({
        workspaces: [{ ...existing, projectKeys: [], deleted: true, updatedAt: now }],
      }),
    );
  });

  const toNone = Effect.fn("BanneretEnrolment.toNone")(function* (
    reason: string,
    message?: string,
    refusedLogin?: string,
  ) {
    yield* persist({
      state: "none",
      relayOrigin: origin,
      ...(refusedLogin ? { refusedLogin } : {}),
      reason,
      ...(message === undefined ? {} : { message }),
    });
    health = undefined;
    unreachableSince = undefined;
    yield* removeSecrets;
    yield* notify;
  });

  const toRevoked = Effect.fn("BanneretEnrolment.toRevoked")(function* (
    from: Enrolled,
    details: unknown,
  ) {
    const reason =
      typeof details === "object" &&
      details !== null &&
      /replac/i.test(String((details as Record<string, unknown>).reason ?? ""))
        ? "replaced"
        : "removed";
    yield* persist({
      state: "revoked",
      relayOrigin: from.relayOrigin,
      displayName: from.displayName,
      label: from.label,
      reason,
    });
    health = undefined;
    unreachableSince = undefined;
    yield* removeSecrets;
    yield* notify;
  });

  /** Runs `effect` under the lock only while the state is still the one a relay call started from. */
  const whileStill = <A>(
    from: Persisted,
    effect: Effect.Effect<A>,
  ): Effect.Effect<Option.Option<A>> =>
    locked(
      Effect.suspend(() => {
        const same =
          current.state === from.state ||
          (isPending(current) && isPending(from)) ||
          (isEnrolled(current) && isEnrolled(from));
        const sameRun =
          same &&
          (isPending(current) && isPending(from)
            ? current.pairingId === from.pairingId
            : isEnrolled(current) && isEnrolled(from)
              ? current.machineId === from.machineId
              : true);
        return sameRun ? Effect.asSome(effect) : Effect.succeedNone;
      }),
    );

  const nextBackoff = () => {
    backoffMs = Math.min(options.maxBackoffMs, backoffMs === 0 ? 2000 : backoffMs * 2);
    return backoffMs;
  };
  // A relay's delay is advice: 0 would spin and a huge value overflows the timer.
  const clampDelay = (ms: number) =>
    Number.isNaN(ms)
      ? options.pollFloorMs
      : Math.min(options.maxBackoffMs, Math.max(options.pollFloorMs, ms));

  // Start-up makes the files agree with one state of the table.
  if (loaded !== undefined) current = loaded;
  yield* locked(
    Effect.gen(function* () {
      let hasKey = Option.isSome(yield* readSecret(KEY_SECRET));
      const hasToken = Option.isSome(yield* readSecret(TOKEN_SECRET));
      const nextKey = yield* readSecret(NEXT_KEY_SECRET);
      // A join again saved `requested` but stopped before its key replaced the old one.
      if (isPending(current) && Option.isSome(nextKey)) {
        yield* setSecret(KEY_SECRET, nextKey.value);
        hasKey = true;
      }
      if (Option.isSome(nextKey)) yield* removeSecret(NEXT_KEY_SECRET);
      switch (current.state) {
        case "none":
        case "revoked":
          if (hasKey || hasToken) yield* removeSecrets;
          break;
        case "requested":
        case "awaiting_approval":
          if (!hasKey) yield* toNone("key_lost");
          else if (hasToken) yield* removeSecret(TOKEN_SECRET);
          break;
        case "approved":
        case "configured":
          if (!hasKey || !hasToken) yield* toNone(hasKey ? "token_lost" : "key_lost");
          else if (current.counterMark !== undefined) startupMark = BigInt(current.counterMark);
          break;
      }
    }),
  );
  if (startupMark !== null) {
    counter = new RelayCounter(() => clock.currentTimeMillisUnsafe(), startupMark);
  }

  const loadKey = readSecret(KEY_SECRET).pipe(Effect.map(Option.map((seed) => keyFromSeed(seed))));
  const loadCredentials = Effect.gen(function* () {
    const key = yield* loadKey;
    const token = yield* readSecret(TOKEN_SECRET);
    if (Option.isNone(key) || Option.isNone(token)) {
      return yield* new RelayCallError({
        status: 0,
        code: "credentials_missing",
        message: "This Hub lost its machine key.",
        retryable: false,
      });
    }
    return { key: key.value, token: Buffer.from(token.value).toString("utf8") };
  });

  const awaitClock = Effect.gen(function* () {
    if (startupMark === null) return;
    const wait = waitBeforeSigning(yield* nowMs(), startupMark, options.maxClockWaitMs);
    if (wait === "clock_wrong") {
      return yield* new RelayCallError({
        status: 0,
        code: "clock_wrong",
        message: "This machine's clock is wrong.",
        retryable: false,
      });
    }
    if (wait > 0) yield* Effect.sleep(wait);
    startupMark = null;
  });

  const saveCounterMark = Effect.gen(function* () {
    const now = yield* nowMs();
    if (now - lastMarkSaveMs < options.counterSaveMs) return;
    lastMarkSaveMs = now;
    yield* locked(
      Effect.suspend(() =>
        isEnrolled(current)
          ? persist({ ...current, counterMark: counter.mark.toString() })
          : Effect.void,
      ),
    );
  });

  const updateHealth = Effect.fn("BanneretEnrolment.updateHealth")(function* (
    error: RelayCallError | null,
  ) {
    if (!isEnrolled(current)) return;
    if (error === null) {
      health = "healthy";
      unreachableSince = undefined;
      return;
    }
    if (error.code === "clock_wrong" || error.code === "clock_skew") health = "clock_wrong";
    else if (error.code === "bad_response") health = "invalid_reply";
    else if (error.status === 0 || error.retryable || error.code === "redirect") {
      if (health !== "unreachable") unreachableSince = yield* nowIso;
      health = "unreachable";
    } else if (error.status === 401) {
      // `unauthenticated` on a token that worked: the relay no longer knows this machine at all.
      health = error.code === "unauthenticated" ? "unknown_machine" : "refused";
    } else if (error.status === 403) health = "forbidden";
  }, Effect.ensuring(notify));

  /** A call with the device token. `counter_reused` gets one retry with a fresh counter. */
  const signedCall = Effect.fn("BanneretEnrolment.signedCall")(function* (
    from: Enrolled,
    method: "GET" | "PUT" | "DELETE" | "POST" | "PATCH",
    target: string,
    ifNoneMatch?: string,
    body?: unknown,
    maxResponseBytes?: number,
  ) {
    const credentials = yield* loadCredentials;
    yield* awaitClock.pipe(Effect.tapError(updateHealth));
    const attempt = Effect.suspend(() =>
      Effect.flatMap(nowMs(), (now) =>
        relayFetch({
          origin: from.relayOrigin,
          ...(from.state === "configured" ? { relayLogin: from.me.login } : {}),
          method,
          target,
          nowMs: now,
          ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
          ...(body === undefined ? {} : { body }),
          ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
          signer: {
            kind: "device",
            key: credentials.key,
            token: credentials.token,
            machineId: from.machineId,
            counter: counter.next(),
          },
        }),
      ),
    );
    const outcome = yield* attempt.pipe(
      Effect.catchIf(
        (error) => error.code === "counter_reused",
        () => attempt,
      ),
      Effect.result,
    );
    yield* saveCounterMark;
    if (Result.isSuccess(outcome)) {
      // While approved, finishSetup decides: an answer without `me` is not healthy.
      if (from.state === "configured") yield* updateHealth(null);
      return outcome.success;
    }
    const error = outcome.failure;
    if (error.code === "token_revoked") {
      yield* whileStill(from, toRevoked(from, error.details));
    } else if (!(from.state === "approved" && error.code === "unauthenticated")) {
      // While approved, `unauthenticated` asks for a re-issued token first (finishSetup).
      yield* updateHealth(error);
    }
    return yield* error;
  });

  const pollPairing = (relayOrigin: string, pairingId: string, key: MachineKey) =>
    Effect.flatMap(nowMs(), (now) =>
      relayFetch({
        origin: relayOrigin,
        method: "POST",
        target: "/relay/v1/enroll/poll",
        body: { pairingId },
        signer: { kind: "enrolment", key },
        nowMs: now,
      }).pipe(Effect.flatMap((reply) => decodeReply(PollReply, reply))),
    ).pipe(Effect.result);

  /** A failed poll: 404 and other refusals end in none; 429, 503 and network errors back off. */
  const pollFailed = Effect.fn("BanneretEnrolment.pollFailed")(function* (
    from: PendingState | Approved,
    error: RelayCallError,
  ) {
    if (error.status === 404) {
      yield* whileStill(from, toNone("not_found"));
      return 0;
    }
    if (error.retryable || error.status === 0) {
      return error.retryAfterMs === undefined ? nextBackoff() : clampDelay(error.retryAfterMs);
    }
    yield* whileStill(from, toNone("refused", error.message));
    return 0;
  });

  // One driver fiber. It acts only in requested, awaiting_approval, approved and configured, so an
  // environment with no enrolment makes no relay call.
  const pollOnce = Effect.fn("BanneretEnrolment.poll")(function* (from: PendingState) {
    // A join again saves `requested` before its key replaces the old one; the new key wins.
    const next = yield* readSecret(NEXT_KEY_SECRET);
    const key = Option.isSome(next) ? Option.some(keyFromSeed(next.value)) : yield* loadKey;
    if (Option.isNone(key)) {
      yield* whileStill(from, toNone("key_lost"));
      return 0;
    }
    const outcome = yield* pollPairing(from.relayOrigin, from.pairingId, key.value);
    if (Result.isFailure(outcome)) return yield* pollFailed(from, outcome.failure);
    backoffMs = 0;
    const reply = outcome.success;
    const delay = clampDelay(reply.retryAfterMs);
    switch (reply.state) {
      case "pending":
        return delay;
      case "awaiting_approval":
        if (from.state !== "awaiting_approval" || from.expiresAt !== reply.expiresAt) {
          yield* whileStill(
            from,
            persist({ ...from, state: "awaiting_approval", expiresAt: reply.expiresAt }),
          );
        }
        return delay;
      case "approved": {
        const { token, machineId } = reply;
        if (token === undefined || machineId === undefined) {
          yield* whileStill(from, toNone("token_lost"));
          return 0;
        }
        yield* whileStill(
          from,
          Effect.gen(function* () {
            yield* setSecret(TOKEN_SECRET, Buffer.from(token, "utf8"));
            yield* persist({
              state: "approved",
              relayOrigin: from.relayOrigin,
              displayName: from.displayName,
              pairingId: from.pairingId,
              machineId,
              label: from.label,
              kind: from.kind,
              startedAt: from.startedAt,
            });
          }),
        );
        return 0;
      }
      case "refused":
      case "expired":
        yield* whileStill(
          from,
          toNone(reply.reason ?? reply.state, undefined, reply.account?.login),
        );
        return 0;
    }
  });

  const findReplaced = Effect.fn("BanneretEnrolment.findReplaced")(function* (
    from: Enrolled & { readonly startedAt: string },
    meId: string,
  ) {
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const reply = yield* signedCall(from, "GET", `/relay/v1/machines?limit=100${query}`);
      const machines = yield* decodeReply(MachinesReply, reply);
      const replaced = machines.items.find(
        (machine) =>
          machine.revokedAt !== undefined &&
          machine.environmentId === environmentId &&
          machine.ownerId === meId &&
          machine.revokedAt >= from.startedAt.replace(/\.\d{3}Z$/, "Z"),
      );
      if (replaced !== undefined) return replaced.label;
      cursor = machines.nextCursor;
      if (cursor === null) return undefined;
    }
    return undefined;
  });

  /**
   * Approved, and the token was refused as `unauthenticated` before any call made with it succeeded:
   * the reply that carried the latest token was lost, or a later poll replaced it. Poll the pairing
   * again and store the fresh token; the next step retries setup with it.
   */
  const reissue = Effect.fn("BanneretEnrolment.reissue")(function* (
    from: Approved,
    refusal: RelayCallError,
  ) {
    const key = yield* loadKey;
    if (Option.isNone(key)) {
      yield* whileStill(from, toNone("key_lost"));
      return 0;
    }
    const outcome = yield* pollPairing(from.relayOrigin, from.pairingId, key.value);
    if (Result.isFailure(outcome)) return yield* pollFailed(from, outcome.failure);
    const reply = outcome.success;
    switch (reply.state) {
      case "approved": {
        const { token } = reply;
        if (token === undefined || reply.machineId !== from.machineId) {
          // The relay saw this machine's token used, so it is not lost: some other refusal.
          yield* updateHealth(refusal);
          return nextBackoff();
        }
        yield* whileStill(from, setSecret(TOKEN_SECRET, Buffer.from(token, "utf8")));
        return nextBackoff();
      }
      case "refused":
      case "expired":
        yield* whileStill(
          from,
          toNone(reply.reason ?? reply.state, undefined, reply.account?.login),
        );
        return 0;
      case "pending":
      case "awaiting_approval":
        yield* whileStill(from, toNone("token_lost"));
        return 0;
    }
  });

  const finishSetup = Effect.fn("BanneretEnrolment.finishSetup")(function* (from: Approved) {
    const outcome = yield* Effect.gen(function* () {
      const capabilities = yield* signedCall(from, "GET", "/relay/v1/capabilities");
      etag = capabilities.etag;
      const { me, team } = yield* decodeReply(EnrolledCapabilities, capabilities);
      const replacedLabel = yield* findReplaced(from, me.id);
      return { me, replacedLabel, community: team?.preset === "community" };
    }).pipe(Effect.result);
    if (Result.isFailure(outcome)) {
      if (outcome.failure.code === "token_revoked") return 0;
      if (outcome.failure.status === 401 && outcome.failure.code === "unauthenticated") {
        return yield* reissue(from, outcome.failure);
      }
      // signedCall records transport failures; an answer that arrived without `me` lands here.
      yield* updateHealth(outcome.failure);
      return nextBackoff();
    }
    backoffMs = 0;
    const { me, replacedLabel, community } = outcome.success;
    const lastOkAt = yield* nowIso;
    yield* whileStill(
      from,
      Effect.gen(function* () {
        yield* putWorkspace(from.relayOrigin, from.displayName);
        yield* persist({
          state: "configured",
          relayOrigin: from.relayOrigin,
          displayName: from.displayName,
          machineId: from.machineId,
          label: from.label,
          kind: from.kind,
          community,
          me,
          lastOkAt,
          ...(replacedLabel === undefined ? {} : { replacedLabel }),
          // The mark signedCall saved meanwhile, not the one this step started from.
          ...(isEnrolled(current) && current.counterMark !== undefined
            ? { counterMark: current.counterMark }
            : {}),
        });
        health = "healthy";
        unreachableSince = undefined;
      }),
    );
    return options.healthIntervalMs;
  });

  const touchLastOk = Effect.fn("BanneretEnrolment.touchLastOk")(function* (from: Configured) {
    const lastOkAt = yield* nowIso;
    yield* whileStill(
      from,
      Effect.sync(() => {
        if (current.state === "configured") current = { ...current, lastOkAt };
      }),
    );
  });

  // Refetched when the heartbeat's capabilitiesVersion moves, so `me` stays current.
  const refreshCapabilities = Effect.fn("BanneretEnrolment.capabilities")(function* (
    from: Configured,
  ) {
    const outcome = yield* signedCall(from, "GET", "/relay/v1/capabilities", etag).pipe(
      Effect.result,
    );
    if (Result.isFailure(outcome)) return;
    const reply = outcome.success;
    if (reply.etag !== undefined) etag = reply.etag;
    const lastOkAt = yield* nowIso;
    const decoded = reply.status === 304 ? Option.none() : decodeEnrolledCapabilities(reply.body);
    const me = Option.getOrElse(
      Option.map(decoded, (body) => body.me),
      () => from.me,
    );
    const community = Option.isSome(decoded)
      ? decoded.value.team?.preset === "community"
      : from.community === true;
    if (
      community !== Boolean(from.community) ||
      me.login !== from.me.login ||
      me.id !== from.me.id ||
      me.role.id !== from.me.role.id ||
      me.role.name !== from.me.role.name ||
      me.admission !== from.me.admission ||
      me.permissions.join(",") !== from.me.permissions.join(",")
    ) {
      yield* whileStill(
        from,
        Effect.suspend(() =>
          current.state === "configured"
            ? persist({ ...current, me, community, lastOkAt })
            : Effect.void,
        ),
      );
    } else {
      yield* touchLastOk(from);
    }
  });

  // The heartbeat (P1-15): machine facts, plus activity facts for this relay's Enterprise projects
  // only (Facts.ts). Its outcome is the machine's health; 401 token_revoked moves to revoked in
  // signedCall. A failed send only reschedules, so nothing waits on it.
  const heartbeat = Effect.fn("BanneretEnrolment.heartbeat")(function* (from: Configured) {
    const tasks = boardTasks;
    const collected = yield* facts.collect(from.relayOrigin, (links) =>
      taskIdForLinks(tasks, links),
    );
    const body = factsRequestBody(
      {
        ...machineFacts(environmentId, from.label, from.kind),
        ...(from.community && { share: "hidden" }),
        ...from.sharing,
      },
      collected,
    );
    const outcome = yield* signedCall(from, "POST", "/relay/v1/facts", undefined, body).pipe(
      Effect.result,
    );
    if (Result.isFailure(outcome)) {
      const error = outcome.failure;
      if (error.code === "token_revoked") return 0;
      if (error.retryable || error.status === 0) {
        return error.retryAfterMs === undefined ? nextBackoff() : clampDelay(error.retryAfterMs);
      }
      return options.healthIntervalMs;
    }
    backoffMs = 0;
    const reply = decodeFactsReply(outcome.success.body);
    snapshotEtag = Option.getOrUndefined(reply)?.snapshotEtag;
    const version = Option.map(reply, (decoded) => decoded.capabilitiesVersion);
    capabilitiesVersion = Option.getOrUndefined(version);
    if (Option.isSome(version) && `"${version.value}"` !== etag) {
      yield* refreshCapabilities(from).pipe(Effect.ignore);
    } else {
      yield* touchLastOk(from);
    }
    return options.healthIntervalMs;
  });

  const step = Effect.suspend((): Effect.Effect<number | "idle"> => {
    const state = current;
    switch (state.state) {
      case "none":
      case "revoked":
        return Effect.succeed("idle" as const);
      case "requested":
      case "awaiting_approval":
        return pollOnce(state);
      case "approved":
        return finishSetup(state);
      case "configured":
        return heartbeat(state);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Banneret relay step failed", cause).pipe(Effect.as(nextBackoff())),
    ),
  );

  // The wake signal is taken before the step, so a wake during the step is not lost.
  yield* Effect.forkIn(
    Effect.forever(
      Effect.suspend(() => {
        const signal = wakeSignal;
        return step.pipe(
          Effect.tap(() => notify),
          Effect.flatMap((delay) =>
            delay === "idle"
              ? Deferred.await(signal)
              : Deferred.await(signal).pipe(
                  Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
                ),
          ),
        );
      }),
    ),
    shared.scope,
  );

  const view = (): BanneretEnrolmentView => {
    const state = current;
    switch (state.state) {
      case "none":
        return {
          ...noneView(origin),
          ...(state.refusedLogin ? { refusedLogin: state.refusedLogin } : {}),
          ...(state.reason === undefined ? {} : { reason: state.reason }),
          ...(state.message === undefined ? {} : { message: state.message }),
        };
      case "requested":
      case "awaiting_approval":
        return {
          state: state.state,
          workspaceId: enterpriseWorkspaceId(state.relayOrigin),
          relayOrigin: state.relayOrigin,
          displayName: state.displayName,
          pairingId: state.pairingId,
          label: state.label,
          confirmCode: state.confirmCode,
          browserUrl: state.browserUrl,
          expiresAt: state.expiresAt,
        };
      case "approved":
        return {
          state: "approved",
          workspaceId: enterpriseWorkspaceId(state.relayOrigin),
          relayOrigin: state.relayOrigin,
          displayName: state.displayName,
          pairingId: state.pairingId,
          machineId: state.machineId,
          label: state.label,
          ...(health === undefined ? {} : { health }),
          ...(unreachableSince === undefined ? {} : { unreachableSince }),
        };
      case "configured":
        return {
          state: "configured",
          workspaceId: enterpriseWorkspaceId(state.relayOrigin),
          relayOrigin: state.relayOrigin,
          displayName: state.displayName,
          machineId: state.machineId,
          label: state.label,
          ...(state.sharing && { sharing: state.sharing }),
          me: state.me,
          ...(state.replacedLabel === undefined ? {} : { replacedLabel: state.replacedLabel }),
          ...(health === undefined ? {} : { health }),
          ...(state.lastOkAt === undefined ? {} : { lastOkAt: state.lastOkAt }),
          ...(unreachableSince === undefined ? {} : { unreachableSince }),
        };
      case "revoked":
        return {
          state: "revoked",
          workspaceId: enterpriseWorkspaceId(state.relayOrigin),
          relayOrigin: state.relayOrigin,
          displayName: state.displayName,
          label: state.label,
          reason: state.reason,
        };
    }
  };

  const start = Effect.fn("BanneretEnrolment.start")(function* (input: {
    readonly origin: string;
    readonly label: string;
    readonly kind: MachineKind;
  }) {
    const label = input.label.trim();
    if (!BANNERET_MACHINE_LABEL_PATTERN.test(label)) {
      return yield* fail(
        "The machine name may use letters, digits, spaces, dots, dashes and underscores (64 at most).",
      );
    }
    return yield* locked(
      Effect.gen(function* () {
        const before = current;
        const joinAgain =
          before.state === "none" ||
          before.state === "revoked" ||
          (before.state === "configured" && (health === "refused" || health === "unknown_machine"));
        if (!joinAgain) {
          return yield* fail("This machine is already joining or has joined this company.");
        }
        // A new attempt drops the previous one's last result, so it never shows during this one.
        if (
          onDisk &&
          before.state === "none" &&
          (before.reason !== undefined || before.message !== undefined)
        ) {
          yield* persist({ state: "none", relayOrigin: origin });
        }
        const relay = yield* probeRelay(input.origin);
        if (relay.origin !== origin) return yield* fail("That is another relay's address.");
        // Beyond that cleared result, nothing is written until the relay has answered: a failed
        // join again keeps the old key, token and state.
        const seed = NodeCrypto.randomBytes(32);
        const key: MachineKey = keyFromSeed(seed);
        const started = yield* Effect.flatMap(nowMs(), (now) =>
          relayFetch({
            origin: relay.origin,
            method: "POST",
            target: "/relay/v1/enroll/start",
            body: {
              publicKey: key.publicKey,
              machine: machineFacts(environmentId, label, input.kind),
            },
            signer: { kind: "enrolment", key },
            nowMs: now,
          }).pipe(Effect.flatMap((reply) => decodeReply(StartReply, reply))),
        ).pipe(Effect.mapError((error) => plainFailure(error, relay.origin)));
        if (originOf(started.browserUrl) !== relay.origin) {
          return yield* fail("The relay's sign-in page is on another address, so joining stopped.");
        }
        if (urlCarries(started.browserUrl, started.confirmCode)) {
          return yield* fail("The relay put the code in its sign-in link, so joining stopped.");
        }
        const replacing = before.state === "configured";
        // A relay that answered for the first time gets its state file before any secret exists,
        // so start-up always finds a state to match the secrets against.
        if (!onDisk) yield* persist({ state: "none", relayOrigin: origin });
        yield* setSecret(replacing ? NEXT_KEY_SECRET : KEY_SECRET, seed);
        yield* persist({
          state: "requested",
          relayOrigin: relay.origin,
          displayName: relay.displayName,
          pairingId: started.pairingId,
          confirmCode: started.confirmCode,
          browserUrl: started.browserUrl,
          expiresAt: started.expiresAt,
          label,
          kind: input.kind,
          startedAt: yield* nowIso,
        });
        health = undefined;
        unreachableSince = undefined;
        backoffMs = 0;
        if (replacing) {
          yield* setSecret(KEY_SECRET, seed);
          yield* removeSecret(NEXT_KEY_SECRET);
          yield* removeSecret(TOKEN_SECRET);
        }
        return view();
      }),
    ).pipe(Effect.tap(() => wake));
  });

  const cancel = locked(
    Effect.gen(function* () {
      if (current.state === "approved") {
        // The relay already approved this machine, so it stays listed until a founder removes it.
        yield* toNone("forgotten");
        return view();
      }
      if (!isPending(current)) return yield* fail("There is no request to cancel.");
      yield* toNone("cancelled");
      return view();
    }),
  ).pipe(
    Effect.tap(() => wake),
    Effect.withSpan("BanneretEnrolment.cancel"),
  );

  const leave = Effect.fn("BanneretEnrolment.leave")(function* (
    mode: "revoke" | "forget",
    keepWorkspace = false,
  ) {
    const from = current;
    // While approved only forget is offered: setup never finished, so there may be no relay to tell.
    if (!isEnrolled(from) || (from.state === "approved" && mode !== "forget")) {
      return yield* fail("This machine has not joined a company.");
    }
    if (mode === "forget") {
      if (health === "healthy" || health === undefined) {
        return yield* fail("Forgetting is offered only while the relay cannot be reached.");
      }
    }
    // A relay that no longer knows this machine (404, or 401 `unauthenticated`) did not see it
    // leave: say so, so the person knows to join again rather than that they left.
    let unknown = false;
    if (mode === "revoke") {
      const outcome = yield* signedCall(
        from,
        "DELETE",
        `/relay/v1/machines/${encodeURIComponent(from.machineId)}`,
      ).pipe(Effect.result);
      if (Result.isFailure(outcome)) {
        const { status, code } = outcome.failure;
        unknown = status === 404 || (status === 401 && code === "unauthenticated");
        if (!unknown && code !== "token_revoked") {
          return yield* plainFailure(outcome.failure, from.displayName);
        }
      }
    }
    yield* locked(
      Effect.gen(function* () {
        if (isEnrolled(current) && current.machineId !== from.machineId) return;
        if (!isEnrolled(current) && current.state !== "revoked") return;
        if (mode === "forget") yield* toNone("forgotten");
        else if (unknown) yield* toNone("unknown_machine", unknownMachineMessage(from.displayName));
        else yield* toNone("left");
        if (!keepWorkspace) yield* tombstoneWorkspace(from.relayOrigin);
      }),
    );
    yield* wake;
    return view();
  });

  const requireConfigured = Effect.suspend(() => {
    const state = current;
    return state.state === "configured"
      ? Effect.succeed(state)
      : fail("This machine has not joined a company.");
  });

  const machines = Effect.fn("BanneretEnrolment.machines")(function* (cursor: string | undefined) {
    const from = yield* requireConfigured;
    const query = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const reply = yield* signedCall(from, "GET", `/relay/v1/machines?limit=50${query}`).pipe(
      Effect.flatMap((reply) => decodeReply(MachinesReply, reply)),
      Effect.mapError((error) => plainFailure(error, from.displayName)),
    );
    return {
      items: reply.items.map((machine) => ({
        id: machine.id,
        label: machine.label,
        kind: machine.kind,
        poolHostId: machine.poolHostId,
        hostname: machine.hostname,
        os: machine.os,
        ownerLogin: machine.ownerLogin,
        connected: machine.connected,
        lastHeardAt: machine.lastHeardAt,
        revocable: machine.revocable ?? false,
        ...(machine.revokedAt === undefined ? {} : { revokedAt: machine.revokedAt }),
        thisMachine: machine.id === from.machineId,
      })),
      nextCursor: reply.nextCursor,
    };
  });

  const revokeMachine = Effect.fn("BanneretEnrolment.revokeMachine")(function* (machineId: string) {
    const from = yield* requireConfigured;
    if (machineId === from.machineId) return yield* fail("Use Leave to remove this machine.");
    const outcome = yield* signedCall(
      from,
      "DELETE",
      `/relay/v1/machines/${encodeURIComponent(machineId)}`,
    ).pipe(Effect.result);
    if (Result.isSuccess(outcome) || outcome.failure.status === 404) return;
    if (outcome.failure.status === 403) {
      return yield* fail("Only the machine's owner or a founder can remove it.");
    }
    return yield* plainFailure(outcome.failure, from.displayName);
  });

  /**
   * The matching seam: which of these git remotes are in the company's repository list. Remotes
   * are hashed here; only the relay's list comes over the wire.
   */
  const matchRepositories = Effect.fn("BanneretEnrolment.matchRepositories")(function* (
    remoteUrls: ReadonlyArray<string>,
  ) {
    const from = yield* requireConfigured;
    const companyKeys = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const reply = yield* signedCall(from, "GET", `/relay/v1/repositories?limit=100${query}`).pipe(
        Effect.flatMap((reply) => decodeReply(RepositoriesReply, reply)),
        Effect.mapError((error) => plainFailure(error, from.displayName)),
      );
      for (const item of reply.items) companyKeys.add(item.projectKey);
      cursor = reply.nextCursor;
      if (cursor === null) break;
    }
    return remoteUrls.slice(0, 1000).filter((remoteUrl) => {
      const key = projectKeyFromRemote(remoteUrl);
      return key !== null && companyKeys.has(key);
    });
  });

  const configuredNow = Effect.suspend(() =>
    current.state === "configured" ? Effect.succeed(current) : notConfigured,
  );

  const signStream = Effect.fn("BanneretEnrolment.signStream")(function* (target: string) {
    const from = yield* configuredNow;
    if (!isRelayApiCall(from.relayOrigin, target)) return yield* notRelayApiError();
    const credentials = yield* loadCredentials;
    yield* awaitClock;
    const counterText = counter.next().toString();
    const sentAt = rfc3339(yield* nowMs());
    const signature = sign(credentials.key, {
      method: "GET",
      target,
      device: from.machineId,
      counter: counterText,
      sentAt,
      body: new Uint8Array(),
    });
    yield* saveCounterMark;
    return {
      origin: from.relayOrigin,
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${credentials.token}`,
        "X-Banneret-Device": from.machineId,
        "X-Banneret-Counter": counterText,
        "X-Banneret-Sent-At": sentAt,
        "X-Banneret-Signature": signature,
      },
    };
  });

  const service: RelayEnrolment = {
    origin,
    status: Effect.sync(view),
    start,
    cancel,
    leave,
    machines,
    revokeMachine,
    matchProjects: matchRepositories,
    nextChange: Effect.sync(() => Deferred.await(changeSignal)),
    signedChat: (method, path, body) =>
      Effect.flatMap(configuredNow, (from) =>
        signedCall(
          from,
          method,
          "/relay/v1/chat/" +
            path.replace(/\/members\/@me$/, "/members/" + encodeURIComponent(from.me.id)),
          undefined,
          body,
        ),
      ),
    officeHeard: Effect.fn("BanneretEnrolment.officeHeard")(function* (ids) {
      const from = yield* requireConfigured;
      if (!ids.length || ids.length > 50 || ids.some((id) => !/^[a-zA-Z0-9_-]{1,64}$/.test(id)))
        return yield* fail("Invalid session selection.");
      return yield* signedCall(
        from,
        "GET",
        "/relay/v1/team/heartbeats?sessions=" + encodeURIComponent(ids.join(",")),
      ).pipe(
        Effect.flatMap((reply) => decodeReply(OfficeHeartbeats, reply)),
        Effect.mapError((error) => plainFailure(error, from.displayName)),
      );
    }),
    officeEdit: Effect.fn("BanneretEnrolment.officeEdit")(function* (action) {
      if (action.kind === "sharing") {
        yield* locked(
          Effect.gen(function* () {
            const from = yield* requireConfigured;
            yield* persist({
              ...from,
              sharing: { share: action.share, shareUsage: action.shareUsage },
            });
          }),
        );
        yield* wake;
        return;
      }
      const from = yield* requireConfigured;
      let path = "/relay/v1/team/me";
      let body;
      if (action.kind === "meeting") {
        if (!from.me.permissions.includes("relay.admin"))
          return yield* fail("Only founders can edit meeting links.");
        if (action.meetingUrl !== null && !officeMeetingUrlValid(action.meetingUrl))
          return yield* fail("Enter a valid HTTPS meeting link.");
        if (action.board !== null && !/^[a-zA-Z0-9_-]{1,64}$/.test(action.board))
          return yield* fail("Invalid room.");
        path =
          "/relay/v1/team/" +
          (action.board === null ? "office" : "rooms/" + encodeURIComponent(action.board));
        body = { meetingUrl: action.meetingUrl };
      } else {
        if (action.status && Buffer.byteLength(action.status.text) > 80)
          return yield* fail("Status exceeds 80 bytes.");
        body = { presence: action.presence, status: action.status };
      }
      yield* signedCall(from, "PUT", path, undefined, body).pipe(
        Effect.mapError((error) => plainFailure(error, from.displayName)),
      );
    }),
    poolFounder: (action) =>
      configuredNow.pipe(
        Effect.flatMap((from) =>
          signedCall(from, action ? "POST" : "GET", "/relay/v1/pool/founder", undefined, action),
        ),
        Effect.flatMap((reply) => decodeReply(PoolFounderView, reply)),
        Effect.mapError((error) => new BanneretRelayError({ message: error.message })),
      ),
    sandbox: (action) =>
      configuredNow.pipe(
        Effect.flatMap((from) => {
          const path = "/relay/v1/pool/sandboxes";
          if (action.kind === "launch") {
            const { hostId, size, image, taskId } = action;
            return signedCall(from, "POST", path, undefined, { hostId, size, image, taskId });
          }
          const target = path + "/" + encodeURIComponent(action.id);
          return signedCall(
            from,
            action.kind === "read" ? "GET" : action.kind === "extend" ? "POST" : "DELETE",
            action.kind === "extend" ? target + "/extend" : target,
          );
        }),
        Effect.flatMap((reply) => decodeReply(SandboxReceipt, reply)),
        Effect.mapError((error) => new BanneretRelayError({ message: error.message })),
      ),
    requestWorkspace: (hostId) =>
      configuredNow.pipe(
        Effect.flatMap((from) =>
          signedCall(from, "POST", "/relay/v1/pool/workspaces", undefined, { hostId }),
        ),
        Effect.flatMap((reply) => decodeReply(WorkspaceReceipt, reply)),
        Effect.mapError((error) => new BanneretRelayError({ message: error.message })),
      ),
    signedGet: (target, options = {}) =>
      Effect.flatMap(configuredNow, (from) =>
        signedCall(from, "GET", target, options.ifNoneMatch, undefined, options.maxResponseBytes),
      ),
    snapshotEtag: Effect.sync(() => snapshotEtag),
    capabilitiesVersion: Effect.sync(() => capabilitiesVersion),
    setBoardTasks: (tasks) =>
      Effect.sync(() => {
        boardTasks = tasks;
      }),
    signStream,
  };
  return service;
});

const make = Effect.fn("BanneretEnrolment.make")(function* (
  overrides: Partial<EnrolmentOptions> = {},
) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const relaysDir = path.join(config.stateDir, "banneret", "relays");

  let changeSignal = Deferred.makeUnsafe<void>();
  const changed = Effect.sync(() => {
    const signal = changeSignal;
    changeSignal = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(signal, Effect.void);
  });

  const shared: RelayShared = {
    options,
    fs,
    path,
    secrets: yield* ServerSecretStore.ServerSecretStore,
    environmentId: yield* (yield* ServerEnvironmentIdentity).getEnvironmentId,
    facts: yield* BanneretFacts,
    context: yield* Effect.context<ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>(),
    clock: yield* Clock.Clock,
    relaysDir,
    scope: yield* Effect.scope,
    changed,
  };

  // Instances are added, never removed: a relay left or refused idles in `none` and calls nobody.
  const relays = new Map<string, RelayEnrolment>();
  const addLock = yield* Semaphore.make(1);

  // Start-up: one instance per state file whose name matches the origin inside it. Anything else
  // in the directory is ignored.
  const names = yield* fs.readDirectory(relaysDir).pipe(Effect.orElseSucceed(() => []));
  for (const name of [...names].toSorted()) {
    const match = /^([0-9a-f]{16})\.json$/.exec(name);
    if (match === null) continue;
    const loaded = yield* fs
      .readFileString(path.join(relaysDir, name))
      .pipe(Effect.flatMap(decodePersisted), Effect.option);
    if (Option.isNone(loaded)) continue;
    const relayOrigin = normalizeOrigin(loaded.value.relayOrigin);
    if (relayOrigin === null || relayHash(relayOrigin) !== match[1]) continue;
    relays.set(relayOrigin, yield* makeRelay(shared, relayOrigin, loaded.value));
  }

  const lookup = (input: string) =>
    Effect.sync(() => {
      const relayOrigin = normalizeOrigin(input);
      return relayOrigin === null ? undefined : relays.get(relayOrigin);
    });
  const joined = (input: string) =>
    lookup(input).pipe(
      Effect.filterOrFail(
        (relay): relay is RelayEnrolment => relay !== undefined,
        () => new BanneretRelayError({ message: "This machine has not joined that company." }),
      ),
    );

  const start = Effect.fn("BanneretEnrolment.start")(function* (input: {
    readonly origin: string;
    readonly label: string;
    readonly kind: MachineKind;
  }) {
    const address = parseBanneretRelayAddress(input.origin);
    if (!address.ok) return yield* fail(address.message);
    const relay = yield* addLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = relays.get(address.origin);
        if (existing !== undefined) return existing;
        const added = yield* makeRelay(shared, address.origin, undefined);
        relays.set(address.origin, added);
        yield* changed;
        return added;
      }),
    );
    return yield* relay.start({ ...input, origin: address.origin });
  });

  const service: EnrolmentService = {
    probe: probeRelay,
    list: Effect.suspend(() =>
      Effect.forEach(
        [...relays.values()].toSorted((a, b) => a.origin.localeCompare(b.origin)),
        (relay) => relay.status,
      ),
    ),
    machine: Effect.sync(() => ({ environmentId: shared.environmentId, ...hostFacts() })),
    status: (relayOrigin) =>
      Effect.flatMap(lookup(relayOrigin), (relay) =>
        relay === undefined
          ? Effect.succeed(noneView(normalizeOrigin(relayOrigin) ?? relayOrigin))
          : relay.status,
      ),
    relay: lookup,
    start,
    cancel: (relayOrigin) => Effect.flatMap(joined(relayOrigin), (relay) => relay.cancel),
    leave: (relayOrigin, mode, keepWorkspace) =>
      Effect.flatMap(joined(relayOrigin), (relay) => relay.leave(mode, keepWorkspace)),
    machines: (relayOrigin, cursor) =>
      Effect.flatMap(joined(relayOrigin), (relay) => relay.machines(cursor)),
    revokeMachine: (relayOrigin, machineId) =>
      Effect.flatMap(joined(relayOrigin), (relay) => relay.revokeMachine(machineId)),
    matchProjects: (relayOrigin, remoteUrls) =>
      Effect.flatMap(joined(relayOrigin), (relay) => relay.matchProjects(remoteUrls)),
    nextChange: Effect.sync(() => Deferred.await(changeSignal)),
  };
  return service;
});

/** What the Hub says when the relay no longer knows this machine. */
const unknownMachineMessage = (displayName: string) =>
  `${displayName} no longer knows this machine (the relay may have been reset). Join again.`;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Whether `url` carries `code`, also once percent-decoded and ignoring case. */
function urlCarries(url: string, code: string): boolean {
  const needle = code.toUpperCase();
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // A malformed escape: the raw text is still checked.
  }
  return url.toUpperCase().includes(needle) || decoded.toUpperCase().includes(needle);
}

function isPending(state: Persisted): state is PendingState {
  return state.state === "requested" || state.state === "awaiting_approval";
}

function isEnrolled(state: Persisted): state is Enrolled {
  return state.state === "approved" || state.state === "configured";
}

export const layerWith = (options: Partial<EnrolmentOptions>) =>
  Layer.effect(BanneretEnrolment, make(options));

export const layer = layerWith({});

/** Handlers for the `banneretRelay.*` RPCs, spread into the WebSocket handler group. */
export const sandboxBooking = Effect.fn("BanneretEnrolment.sandbox")(function* (input: {
  relayOrigin: string;
  action: typeof SandboxAction.Type;
}) {
  const service = yield* BanneretEnrolment;
  const relay = yield* service.relay(input.relayOrigin);
  if (!relay) return yield* fail("This machine has not joined the company.");
  return yield* relay.sandbox(input.action);
});

export const poolResources = Effect.fn("BanneretEnrolment.pool")(function* (input: {
  readonly relayOrigin: string;
}) {
  const service = yield* BanneretEnrolment;
  const relay = yield* service.relay(input.relayOrigin);
  if (!relay) return yield* fail("This machine has not joined the company.");
  return yield* relay.signedGet("/relay/v1/pool").pipe(
    Effect.flatMap((reply) => decodeReply(PoolResources, reply)),
    Effect.mapError(() => new BanneretRelayError({ message: "Pool resources are unavailable." })),
  );
});

export const rpcHandlers = {
  [BANNERET_RELAY_WS_METHODS.tailscaleLogin]: () => Effect.promise(() => readTailscaleLogin()),
  [BANNERET_RELAY_WS_METHODS.resources]: Effect.fn("BanneretEnrolment.resources")(
    function* (input: { readonly policy?: WarningPolicy | undefined }) {
      const { cwd } = yield* ServerConfig.ServerConfig;
      return yield* Effect.tryPromise({
        try: () => ownResources(input.policy, cwd),
        catch: () => new BanneretRelayError({ message: "Resources could not be read." }),
      });
    },
  ),
  [BANNERET_RELAY_WS_METHODS.folders]: () =>
    Effect.tryPromise({
      try: biggestFolders,
      catch: () => new BanneretRelayError({ message: "Home folder sizes could not be read." }),
    }),
  [BANNERET_RELAY_WS_METHODS.officeEdit]: Effect.fn("BanneretEnrolment.officeEditRpc")(
    function* (input: { relayOrigin: string; action: OfficeEdit }) {
      const relay = yield* (yield* BanneretEnrolment).relay(input.relayOrigin);
      if (!relay) return yield* fail("This machine has not joined the company.");
      return yield* relay.officeEdit(input.action);
    },
  ),
  [BANNERET_RELAY_WS_METHODS.officeHeard]: Effect.fn("BanneretEnrolment.officeHeardRpc")(
    function* (input: { relayOrigin: string; ids: readonly string[] }) {
      const relay = yield* (yield* BanneretEnrolment).relay(input.relayOrigin);
      if (!relay) return yield* fail("This machine has not joined the company.");
      return yield* relay.officeHeard(input.ids);
    },
  ),
  [BANNERET_RELAY_WS_METHODS.poolFounder]: Effect.fn("BanneretEnrolment.poolFounder")(
    function* (input: { relayOrigin: string; action?: PoolFounderAction | undefined }) {
      const service = yield* BanneretEnrolment;
      const relay = yield* service.relay(input.relayOrigin);
      if (!relay) return yield* fail("This machine has not joined the company.");
      return yield* relay.poolFounder(input.action);
    },
  ),
  [BANNERET_RELAY_WS_METHODS.sandbox]: sandboxBooking,
  [BANNERET_RELAY_WS_METHODS.requestWorkspace]: Effect.fn("BanneretEnrolment.requestWorkspace")(
    function* (input: { relayOrigin: string; hostId: string }) {
      const service = yield* BanneretEnrolment;
      const relay = yield* service.relay(input.relayOrigin);
      if (!relay) return yield* fail("This machine has not joined the company.");
      return yield* relay.requestWorkspace(input.hostId);
    },
  ),
  [BANNERET_RELAY_WS_METHODS.pool]: poolResources,
  [BANNERET_RELAY_WS_METHODS.probe]: (input: { readonly origin: string }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) => enrolment.probe(input.origin)),
  [BANNERET_RELAY_WS_METHODS.status]: () =>
    Effect.flatMap(BanneretEnrolment, (enrolment) =>
      Effect.map(Effect.all([enrolment.list, enrolment.machine]), ([enrolments, machine]) => ({
        enrolments,
        machine,
      })),
    ),
  [BANNERET_RELAY_WS_METHODS.start]: (input: {
    readonly origin: string;
    readonly label: string;
    readonly kind: MachineKind;
  }) => Effect.flatMap(BanneretEnrolment, (enrolment) => enrolment.start(input)),
  [BANNERET_RELAY_WS_METHODS.cancel]: (input: { readonly relayOrigin: string }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) => enrolment.cancel(input.relayOrigin)),
  [BANNERET_RELAY_WS_METHODS.leave]: (input: {
    readonly relayOrigin: string;
    readonly mode: "revoke" | "forget";
    readonly keepWorkspace: boolean;
  }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) =>
      enrolment.leave(input.relayOrigin, input.mode, input.keepWorkspace),
    ),
  [BANNERET_RELAY_WS_METHODS.machines]: (input: {
    readonly relayOrigin: string;
    readonly cursor?: string | undefined;
  }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) =>
      enrolment.machines(input.relayOrigin, input.cursor),
    ),
  [BANNERET_RELAY_WS_METHODS.revokeMachine]: (input: {
    readonly relayOrigin: string;
    readonly machineId: string;
  }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) =>
      Effect.as(enrolment.revokeMachine(input.relayOrigin, input.machineId), {}),
    ),
  [BANNERET_RELAY_WS_METHODS.matchProjects]: (input: {
    readonly relayOrigin: string;
    readonly remoteUrls: ReadonlyArray<string>;
  }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) =>
      Effect.map(enrolment.matchProjects(input.relayOrigin, input.remoteUrls), (matched) => ({
        matched,
      })),
    ),
};
