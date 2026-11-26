// @effect-diagnostics nodeBuiltinImport:off - node:os machine facts and node:crypto seed and digest are synchronous.
// Banneret Hub: this environment's enrolment in a company relay. One enrolment per environment.
// The persisted state is one of six values (see the state table in the PR that added this file);
// health is run-time only. Writes go secrets first, then the state file; removals go state file
// first, then secrets, and start-up deletes secrets that no state matches.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  BANNERET_MACHINE_LABEL_PATTERN,
  BANNERET_RELAY_WS_METHODS,
  BanneretMachineKind,
  BanneretRelayError,
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
import * as Semaphore from "effect/Semaphore";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as Workspaces from "../Workspaces.ts";
import { projectKeyFromRemote } from "./projectKey.ts";
import { RelayCallError, type RelayReply, relayFetch } from "./RelayClient.ts";
import { type MachineKey, RelayCounter, keyFromSeed, waitBeforeSigning } from "./RelaySigning.ts";

export const KEY_SECRET = "banneret-relay-key";
export const TOKEN_SECRET = "banneret-relay-token";
/** A new pairing's key while the old enrolment's key must survive until `requested` is saved. */
export const NEXT_KEY_SECRET = "banneret-relay-key-next";

const Me = Schema.Struct({ id: Schema.String, login: Schema.String, role: Schema.String });

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
    reason: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
  Schema.Struct({ state: Schema.Literals(["requested", "awaiting_approval"]), ...Pending }),
  Schema.Struct({
    state: Schema.Literal("approved"),
    relayOrigin: Schema.String,
    displayName: Schema.String,
    machineId: Schema.String,
    label: Schema.String,
    startedAt: Schema.String,
    counterMark: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("configured"),
    relayOrigin: Schema.String,
    displayName: Schema.String,
    machineId: Schema.String,
    label: Schema.String,
    me: Me,
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
  reason: Schema.optional(Schema.String),
});
const PublicCapabilities = Schema.Struct({
  protocol: Schema.String,
  displayName: Schema.String,
  enrolment: Schema.Struct({ start: Schema.String, browser: Schema.String }),
});
const EnrolledCapabilities = Schema.Struct({ me: Me });
const MachinesReply = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      environmentId: Schema.String,
      ownerId: Schema.String,
      ownerLogin: Schema.String,
      label: Schema.String,
      kind: Schema.String,
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

const decodeEnrolledCapabilities = Schema.decodeUnknownOption(EnrolledCapabilities);
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
const enterpriseWorkspaceId = (origin: string) =>
  `ent-${NodeCrypto.createHash("sha256").update(origin).digest("hex").slice(0, 16)}`;

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

/** Machine facts for `enroll/start`, sanitised to the contract's patterns. Never a path. */
const machineFacts = (environmentId: string, label: string, kind: MachineKind) => ({
  environmentId,
  label,
  kind,
  hostname: sanitize(
    NodeOS.hostname(),
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/,
    /[^A-Za-z0-9.-]+/g,
    "hub",
    253,
  ),
  os: sanitize(
    `${NodeOS.type()} ${NodeOS.release()}`,
    /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/,
    /[^A-Za-z0-9 ._()-]+/g,
    "unknown",
    64,
  ),
  hubVersion: sanitize(
    packageJson.version,
    /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/,
    /[^0-9A-Za-z.+-]+/g,
    "0",
    64,
  ),
  policyFingerprint: null,
  sandbox: { enabled: false, image: null },
});

export interface EnrolmentOptions {
  readonly pollFloorMs: number;
  readonly healthIntervalMs: number;
  readonly counterSaveMs: number;
  readonly maxBackoffMs: number;
  readonly maxClockWaitMs: number;
  /** Tests: runs before every durable write; a defect here stands for a crash at that step. */
  readonly beforeWrite?: (step: string) => Effect.Effect<void>;
}

const DEFAULT_OPTIONS: EnrolmentOptions = {
  pollFloorMs: 1000,
  healthIntervalMs: 60_000,
  counterSaveMs: 5000,
  maxBackoffMs: 60_000,
  maxClockWaitMs: 120_000,
};

interface EnrolmentService {
  readonly probe: (origin: string) => Effect.Effect<BanneretRelayProbeResult, BanneretRelayError>;
  readonly status: Effect.Effect<BanneretEnrolmentView>;
  readonly start: (input: {
    readonly origin: string;
    readonly label: string;
    readonly kind: MachineKind;
  }) => Effect.Effect<BanneretEnrolmentView, BanneretRelayError>;
  readonly cancel: Effect.Effect<BanneretEnrolmentView, BanneretRelayError>;
  readonly leave: (
    mode: "revoke" | "forget",
  ) => Effect.Effect<BanneretEnrolmentView, BanneretRelayError>;
  readonly machines: (
    cursor: string | undefined,
  ) => Effect.Effect<BanneretRelayMachinesPage, BanneretRelayError>;
  readonly revokeMachine: (machineId: string) => Effect.Effect<void, BanneretRelayError>;
  readonly matchProjects: (
    remoteUrls: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, BanneretRelayError>;
  /** An effect that completes at the next change of the view or the files, or driver step. */
  readonly nextChange: Effect.Effect<Effect.Effect<void>>;
}

const notRunning = Effect.fail(
  new BanneretRelayError({ message: "Enterprise enrolment is not running on this server." }),
);

/**
 * A reference, not a required service: a server built without the enrolment layer (tests, older
 * wiring) answers as an environment that never enrolled, and still makes no relay call.
 */
export class BanneretEnrolment extends Context.Reference<EnrolmentService>(
  "t3/banneret/relay/Enrolment/BanneretEnrolment",
  {
    defaultValue: () => ({
      probe: () => notRunning,
      status: Effect.succeed({ state: "none" }),
      start: () => notRunning,
      cancel: notRunning,
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
  if (error.status === 401)
    return new BanneretRelayError({ message: "The relay refused this machine." });
  if (error.status === 403)
    return new BanneretRelayError({ message: "The relay does not allow this." });
  if (error.retryable)
    return new BanneretRelayError({ message: `${relay} is unavailable. Try again later.` });
  return new BanneretRelayError({ message: error.message });
};

const make = Effect.fn("BanneretEnrolment.make")(function* (
  overrides: Partial<EnrolmentOptions> = {},
) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const context = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const stateFile = path.join(config.stateDir, "banneret", "enrolment.json");
  const clock = yield* Clock.Clock;
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  const nowMs = () => Clock.currentTimeMillis;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  let current: Persisted = { state: "none" };
  let health: BanneretRelayHealth | undefined;
  let unreachableSince: string | undefined;
  let etag: string | undefined;
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
  });

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
  ) {
    yield* persist({ state: "none", reason, ...(message === undefined ? {} : { message }) });
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
  const loaded = yield* fs.readFileString(stateFile).pipe(
    Effect.flatMap(decodePersisted),
    Effect.orElseSucceed((): Persisted => ({ state: "none" })),
  );
  current = loaded;
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
    } else if (error.status === 401) health = "refused";
    else if (error.status === 403) health = "forbidden";
  }, Effect.ensuring(notify));

  /** A call with the device token. `counter_reused` gets one retry with a fresh counter. */
  const signedCall = Effect.fn("BanneretEnrolment.signedCall")(function* (
    from: Enrolled,
    method: "GET" | "DELETE",
    target: string,
    ifNoneMatch?: string,
  ) {
    const credentials = yield* loadCredentials;
    yield* awaitClock.pipe(Effect.tapError(updateHealth));
    const attempt = Effect.suspend(() =>
      Effect.flatMap(nowMs(), (now) =>
        relayFetch({
          origin: from.relayOrigin,
          method,
          target,
          nowMs: now,
          ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
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
    } else {
      yield* updateHealth(error);
    }
    return yield* error;
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
    const outcome = yield* Effect.flatMap(nowMs(), (now) =>
      relayFetch({
        origin: from.relayOrigin,
        method: "POST",
        target: "/relay/v1/enroll/poll",
        body: { pairingId: from.pairingId },
        signer: { kind: "enrolment", key: key.value },
        nowMs: now,
      }).pipe(Effect.flatMap((reply) => decodeReply(PollReply, reply))),
    ).pipe(Effect.result);
    if (Result.isFailure(outcome)) {
      const error = outcome.failure;
      if (error.status === 404) {
        yield* whileStill(from, toNone("not_found"));
        return 0;
      }
      if (error.retryable || error.status === 0) {
        return error.retryAfterMs === undefined ? nextBackoff() : clampDelay(error.retryAfterMs);
      }
      yield* whileStill(from, toNone("refused", error.message));
      return 0;
    }
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
              machineId,
              label: from.label,
              startedAt: from.startedAt,
            });
          }),
        );
        return 0;
      }
      case "refused":
      case "expired":
        yield* whileStill(from, toNone(reply.reason ?? reply.state));
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

  const finishSetup = Effect.fn("BanneretEnrolment.finishSetup")(function* (
    from: Extract<Persisted, { state: "approved" }>,
  ) {
    const outcome = yield* Effect.gen(function* () {
      const capabilities = yield* signedCall(from, "GET", "/relay/v1/capabilities");
      etag = capabilities.etag;
      const { me } = yield* decodeReply(EnrolledCapabilities, capabilities);
      const replacedLabel = yield* findReplaced(from, me.id);
      return { me, replacedLabel };
    }).pipe(Effect.result);
    if (Result.isFailure(outcome)) {
      if (outcome.failure.code === "token_revoked") return 0;
      // signedCall records transport failures; an answer that arrived without `me` lands here.
      yield* updateHealth(outcome.failure);
      return nextBackoff();
    }
    backoffMs = 0;
    const { me, replacedLabel } = outcome.success;
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
          me,
          lastOkAt,
          ...(replacedLabel === undefined ? {} : { replacedLabel }),
          // The mark signedCall saved meanwhile, not the one this step started from.
          ...(isEnrolled(current) && current.counterMark !== undefined
            ? { counterMark: current.counterMark }
            : {}),
        });
        health = "healthy";
      }),
    );
    return options.healthIntervalMs;
  });

  // Facts seam: the heartbeat (POST /facts) belongs here in a later slice. It will send activity
  // facts only for threads in Enterprise projects, plus machine facts while enrolled. Until then
  // health is this signed GET /capabilities.
  const healthCheck = Effect.fn("BanneretEnrolment.health")(function* (from: Configured) {
    const outcome = yield* signedCall(from, "GET", "/relay/v1/capabilities", etag).pipe(
      Effect.result,
    );
    if (Result.isFailure(outcome)) return options.healthIntervalMs;
    const reply = outcome.success;
    if (reply.etag !== undefined) etag = reply.etag;
    const lastOkAt = yield* nowIso;
    const me =
      reply.status === 304
        ? from.me
        : Option.getOrElse(
            Option.map(decodeEnrolledCapabilities(reply.body), (body) => body.me),
            () => from.me,
          );
    if (me.login !== from.me.login || me.role !== from.me.role) {
      yield* whileStill(
        from,
        Effect.suspend(() =>
          current.state === "configured" ? persist({ ...current, me, lastOkAt }) : Effect.void,
        ),
      );
    } else {
      yield* whileStill(
        from,
        Effect.sync(() => {
          if (current.state === "configured") current = { ...current, lastOkAt };
        }),
      );
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
        return healthCheck(state);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Banneret relay step failed", cause).pipe(Effect.as(nextBackoff())),
    ),
  );

  // The wake signal is taken before the step, so a wake during the step is not lost.
  yield* Effect.forkScoped(
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
  );

  const view = (): BanneretEnrolmentView => {
    const state = current;
    switch (state.state) {
      case "none":
        return {
          state: "none",
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
          me: { login: state.me.login, role: state.me.role },
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

  const probeRelay = Effect.fn("BanneretEnrolment.probe")(function* (input: string) {
    const address = parseBanneretRelayAddress(input);
    if (!address.ok) return yield* fail(address.message);
    const reply = yield* Effect.flatMap(nowMs(), (now) =>
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
      !/^1\.(0|[1-9][0-9]*)$/.test(capabilities.protocol) ||
      capabilities.enrolment.start !== "/relay/v1/enroll/start" ||
      capabilities.displayName.length === 0 ||
      capabilities.displayName.length > 80
    ) {
      return yield* fail("That address is not a relay this version of Banneret Hub can join.");
    }
    return {
      origin: address.origin,
      displayName: capabilities.displayName,
      protocol: capabilities.protocol,
    };
  });

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
          (before.state === "configured" && health === "refused");
        if (!joinAgain) {
          return yield* fail("This machine is already joining or joined to a company.");
        }
        const relay = yield* probeRelay(input.origin);
        // Nothing is written until the relay has answered: a failed join again keeps the old key,
        // token and state.
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

  const leave = Effect.fn("BanneretEnrolment.leave")(function* (mode: "revoke" | "forget") {
    const from = current;
    // While approved only forget is offered: setup never finished, so there may be no relay to tell.
    if (!isEnrolled(from) || (from.state === "approved" && mode !== "forget")) {
      return yield* fail("This machine has not joined a company.");
    }
    if (mode === "forget") {
      if (health === "healthy" || health === undefined) {
        return yield* fail("Forgetting is offered only while the relay cannot be reached.");
      }
    } else {
      const outcome = yield* signedCall(
        from,
        "DELETE",
        `/relay/v1/machines/${encodeURIComponent(from.machineId)}`,
      ).pipe(Effect.result);
      if (
        Result.isFailure(outcome) &&
        outcome.failure.status !== 404 &&
        outcome.failure.code !== "token_revoked"
      ) {
        return yield* plainFailure(outcome.failure, from.displayName);
      }
    }
    yield* locked(
      Effect.gen(function* () {
        if (isEnrolled(current) && current.machineId !== from.machineId) return;
        if (!isEnrolled(current) && current.state !== "revoked") return;
        yield* toNone(mode === "revoke" ? "left" : "forgotten");
        yield* tombstoneWorkspace(from.relayOrigin);
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

  const service: EnrolmentService = {
    probe: probeRelay,
    status: Effect.sync(view),
    start,
    cancel,
    leave,
    machines,
    revokeMachine,
    matchProjects: matchRepositories,
    nextChange: Effect.sync(() => Deferred.await(changeSignal)),
  };
  return service;
});

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
export const rpcHandlers = {
  [BANNERET_RELAY_WS_METHODS.probe]: (input: { readonly origin: string }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) => enrolment.probe(input.origin)),
  [BANNERET_RELAY_WS_METHODS.status]: () =>
    Effect.flatMap(BanneretEnrolment, (enrolment) => enrolment.status),
  [BANNERET_RELAY_WS_METHODS.start]: (input: {
    readonly origin: string;
    readonly label: string;
    readonly kind: MachineKind;
  }) => Effect.flatMap(BanneretEnrolment, (enrolment) => enrolment.start(input)),
  [BANNERET_RELAY_WS_METHODS.cancel]: () =>
    Effect.flatMap(BanneretEnrolment, (enrolment) => enrolment.cancel),
  [BANNERET_RELAY_WS_METHODS.leave]: (input: { readonly mode: "revoke" | "forget" }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) => enrolment.leave(input.mode)),
  [BANNERET_RELAY_WS_METHODS.machines]: (input: { readonly cursor?: string | undefined }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) => enrolment.machines(input.cursor)),
  [BANNERET_RELAY_WS_METHODS.revokeMachine]: (input: { readonly machineId: string }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) =>
      Effect.as(enrolment.revokeMachine(input.machineId), {}),
    ),
  [BANNERET_RELAY_WS_METHODS.matchProjects]: (input: {
    readonly remoteUrls: ReadonlyArray<string>;
  }) =>
    Effect.flatMap(BanneretEnrolment, (enrolment) =>
      Effect.map(enrolment.matchProjects(input.remoteUrls), (matched) => ({ matched })),
    ),
};
