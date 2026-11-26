// @effect-diagnostics nodeBuiltinImport:off - node:crypto random ids and digest are synchronous.
// Banneret Hub: what the heartbeat (POST /facts) reports besides the machine itself. Activity facts
// come only from threads in projects of this relay's Enterprise workspace (P1-18, §7.4); usage only
// from this machine's own provider logins (P2-11). Every field is built one by one from upstream
// state: no title, message, path or remote ever reaches a fact.
import * as NodeCrypto from "node:crypto";

import {
  type BanneretWorkspace,
  ManagedPolicyDocument,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  repositoryGroupingKeyOf,
  type ServerProvider,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as Workspaces from "../Workspaces.ts";
import { projectKeyFromRemote } from "./projectKey.ts";
import { rfc3339 } from "./RelaySigning.ts";

const MAX_ACTIVITY = 256;
const MAX_USAGE = 32;
/** Threads read per heartbeat at most, in upstream's shell order. */
const MAX_THREAD_READ = 512;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const PROVIDER_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const WINDOW = /^[a-z0-9][a-z0-9_]{0,31}$/;

export interface ActivityFact {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly threadId: string;
  readonly projectKey: string;
  readonly branch?: string;
  readonly provider: "claude" | "codex";
  readonly providerVersion?: string;
  readonly model?: string;
  readonly state: "working" | "waiting" | "idle" | "stopped";
  readonly waiting?: "permission" | "question" | "input";
  readonly stopReason?: "completed" | "usage_limit" | "error" | "killed" | "not_reported";
  readonly processRunning: boolean;
  readonly startedAt: string;
  readonly lastSeenAt: string;
}

export interface UsageFact {
  readonly provider: string;
  readonly window: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

export interface FactsCollection {
  readonly activity: ReadonlyArray<ActivityFact>;
  /** Empty when no provider reading is available; the heartbeat then omits `usage`. */
  readonly usage: ReadonlyArray<UsageFact>;
  readonly policyFingerprint: string | null;
}

export type FactsProject = Pick<
  OrchestrationProjectShell,
  "id" | "workspaceRoot" | "repositoryIdentity"
>;

export type FactsThread = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "providerInstanceId"
  | "modelSelection"
  | "branch"
  | "lineage"
  | "status"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "latestRunId"
  | "latestRunStartedAt"
  | "lastErrorClass"
  | "createdAt"
  | "updatedAt"
  | "settledAt"
  | "settledOverride"
  | "archivedAt"
  | "deletedAt"
>;

export type FactsProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "version" | "auth" | "usageLimits"
>;

export class FactsReadError extends Schema.TaggedError<FactsReadError>()("FactsReadError", {
  cause: Schema.Defect(),
}) {}

/** Upstream state the facts are built from. The server reads it through existing services. */
export interface FactsInputs {
  readonly environmentId: string;
  readonly workspaces: Effect.Effect<ReadonlyArray<BanneretWorkspace>, FactsReadError>;
  readonly projects: Effect.Effect<ReadonlyArray<FactsProject>, FactsReadError>;
  /** Threads of these projects only; threads of other projects are never read. */
  readonly threads: (
    projectIds: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyArray<FactsThread>, FactsReadError>;
  readonly providers: Effect.Effect<ReadonlyArray<FactsProvider>, FactsReadError>;
  readonly policyFingerprint: Effect.Effect<string | null, FactsReadError>;
}

const readError = (cause: unknown) => new FactsReadError({ cause });

export class BanneretFacts extends Context.Service<
  BanneretFacts,
  {
    /** Never fails: a failed read reports the last activity it read, not an empty set. */
    readonly collect: (relayOrigin: string) => Effect.Effect<FactsCollection>;
  }
>()("t3/banneret/relay/Facts/BanneretFacts") {}

const newestFirst = (a: BanneretWorkspace, b: BanneretWorkspace) =>
  a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt > b.updatedAt ? -1 : 1;

/**
 * The projects of this relay's Enterprise workspace, with their `projectKey`. Claims resolve as the
 * web's `resolveWorkspaces` does (newest workspace wins a key). A project any other workspace also
 * claims, or with no hashable git remote, is left out: when in doubt, nothing is reported.
 */
export function enterpriseProjects(input: {
  readonly workspaces: ReadonlyArray<BanneretWorkspace>;
  readonly projects: ReadonlyArray<FactsProject>;
  readonly relayOrigin: string;
  readonly environmentId: string;
}): Map<string, string> {
  const owner = new Map<string, BanneretWorkspace>();
  for (const workspace of input.workspaces
    .filter((candidate) => candidate.deleted !== true)
    .toSorted(newestFirst)) {
    for (const key of workspace.projectKeys) if (!owner.has(key)) owner.set(key, workspace);
  }
  const result = new Map<string, string>();
  for (const project of input.projects) {
    const identity = project.repositoryIdentity ?? null;
    const keys = [
      `path:${input.environmentId}:${normalizeProjectPathForComparison(project.workspaceRoot)}`,
      ...(identity === null ? [] : [`repo:${repositoryGroupingKeyOf(identity)}`]),
    ];
    const owners = new Set(keys.flatMap((key) => owner.get(key) ?? []));
    const [only] = owners;
    if (
      owners.size !== 1 ||
      only === undefined ||
      only.kind !== "enterprise" ||
      only.relay?.origin !== input.relayOrigin ||
      identity === null
    ) {
      continue;
    }
    // The same remote the Enterprise wizard matches against the relay's repository list.
    const projectKey = projectKeyFromRemote(identity.locator.remoteUrl);
    if (projectKey !== null) result.set(project.id, projectKey);
  }
  return result;
}

const providerName = (driver: string): "claude" | "codex" | null =>
  driver === "claudeAgent" ? "claude" : driver === "codex" ? "codex" : null;

const isoOf = (value: DateTime.Utc) => rfc3339(DateTime.toEpochMillis(value));

const LIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

type Liveness = Pick<ActivityFact, "state" | "waiting" | "stopReason" | "processRunning">;

/**
 * P2-6 from upstream's own thread state, as the sidebar reads it: an open approval or question is
 * "waiting for you"; a live run is working; a finished run waits for the person's next message; a
 * failed or stopped run is stopped. Null when the thread has no session to report.
 */
function livenessOf(thread: FactsThread): Liveness | null {
  const request = thread.pendingRuntimeRequest?.kind;
  if (request !== undefined && request !== "auth_refresh") {
    return {
      state: "waiting",
      waiting: request === "user_input" ? "question" : "permission",
      processRunning: true,
    };
  }
  const status =
    thread.activityRunStatus !== undefined && thread.activityRunStatus !== null
      ? thread.activityRunStatus
      : thread.status;
  if (LIVE_RUN.has(status)) return { state: "working", processRunning: true };
  // A subagent whose run ended has no session of its own; its parent carries the work.
  if (thread.lineage.relationshipToParent === "subagent") return null;
  if (thread.latestRunId === null) return null;
  switch (status) {
    case "failed":
      return {
        state: "stopped",
        stopReason: thread.lastErrorClass === "usage_limit" ? "usage_limit" : "error",
        processRunning: false,
      };
    case "interrupted":
    case "cancelled":
      return { state: "stopped", stopReason: "killed", processRunning: false };
    default:
      return { state: "waiting", waiting: "input", processRunning: false };
  }
}

/** Activity facts for the threads of `projects` (id → projectKey). Session ids live in `sessions`. */
export function buildActivity(input: {
  readonly threads: ReadonlyArray<FactsThread>;
  readonly projects: ReadonlyMap<string, string>;
  readonly providers: ReadonlyArray<FactsProvider>;
  readonly sessions: Map<string, string>;
}): ActivityFact[] {
  const byInstance = new Map(input.providers.map((provider) => [provider.instanceId, provider]));
  const candidates = input.threads
    .filter(
      (thread) =>
        input.projects.has(thread.projectId) &&
        ID.test(thread.id) &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        thread.settledAt === null &&
        thread.settledOverride !== "settled",
    )
    .toSorted((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt));

  const facts: ActivityFact[] = [];
  const seen = new Set<string>();
  for (const thread of candidates) {
    if (facts.length >= MAX_ACTIVITY) break;
    const liveness = livenessOf(thread);
    const instance = byInstance.get(thread.providerInstanceId);
    const provider = instance === undefined ? null : providerName(instance.driver);
    const projectKey = input.projects.get(thread.projectId);
    if (liveness === null || provider === null || projectKey === undefined) continue;
    let sessionId = input.sessions.get(thread.id);
    if (sessionId === undefined) {
      sessionId = `s_${NodeCrypto.randomBytes(12).toString("base64url")}`;
      input.sessions.set(thread.id, sessionId);
    }
    seen.add(thread.id);
    const branch = thread.branch ?? "";
    const model = thread.modelSelection.model;
    const version = instance?.version ?? "";
    facts.push({
      sessionId,
      threadId: thread.id,
      projectKey,
      ...(BRANCH.test(branch) ? { branch } : {}),
      provider,
      ...(PROVIDER_VERSION.test(version) ? { providerVersion: version } : {}),
      ...(MODEL.test(model) ? { model } : {}),
      state: liveness.state,
      ...(liveness.waiting === undefined ? {} : { waiting: liveness.waiting }),
      ...(liveness.stopReason === undefined ? {} : { stopReason: liveness.stopReason }),
      processRunning: liveness.processRunning,
      startedAt: isoOf(thread.latestRunStartedAt ?? thread.createdAt),
      lastSeenAt: isoOf(thread.updatedAt),
    });
  }
  for (const threadId of input.sessions.keys()) {
    if (!seen.has(threadId)) input.sessions.delete(threadId);
  }
  // Helpers point at their parent's session when the parent is reported too.
  const threadParents = new Map<string, FactsThread["lineage"]>(
    candidates.map((thread) => [thread.id, thread.lineage]),
  );
  return facts.map((fact) => {
    const lineage = threadParents.get(fact.threadId);
    const parent =
      lineage?.relationshipToParent === "subagent" && lineage.parentThreadId !== null
        ? input.sessions.get(lineage.parentThreadId)
        : undefined;
    return parent === undefined ? fact : { ...fact, parentSessionId: parent };
  });
}

const scopedToken = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function windowName(
  window: NonNullable<FactsProvider["usageLimits"]>["windows"][number],
): string | null {
  const base =
    window.kind === "session"
      ? window.windowDurationMins === undefined || window.windowDurationMins === 300
        ? "5h"
        : window.windowDurationMins % 60 === 0
          ? `${window.windowDurationMins / 60}h`
          : `${window.windowDurationMins}m`
      : window.kind;
  // A model-scoped allowance (Claude's `seven_day_<model>`, or one naming its models) keeps its scope.
  const scoped =
    window.kind === "other" ||
    (window.modelIds?.length ?? 0) > 0 ||
    (window.providerIds?.length ?? 0) > 0 ||
    /^seven_day_./.test(window.id);
  const name = scoped
    ? `${base}_${scopedToken(window.id.replace(/^seven_day_/, ""))}`.slice(0, 32)
    : base;
  return WINDOW.test(name) ? name : null;
}

const resetsAtOf = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? rfc3339(DateTime.toEpochMillis(parsed.value)) : null;
};

/**
 * Usage windows of this machine's own Claude and Codex logins, from the readings upstream already
 * keeps for its usage bars. Instances that send requests to a custom endpoint are someone else's
 * account, and unreadable readings are skipped. Only provider, window, percent and reset time.
 */
function buildUsage(providers: ReadonlyArray<FactsProvider>): UsageFact[] {
  const usage: UsageFact[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    const name = providerName(provider.driver);
    const limits = provider.usageLimits;
    if (
      name === null ||
      provider.auth.status !== "authenticated" ||
      provider.auth.endpoint !== undefined ||
      limits === undefined ||
      limits.unavailable !== undefined
    ) {
      continue;
    }
    // One login can back several instances; report it once.
    const login = limits.credentialFingerprint ?? provider.instanceId;
    for (const window of limits.windows) {
      const windowId = windowName(window);
      if (windowId === null || !Number.isFinite(window.usedPercent)) continue;
      const key = `${name}\n${login}\n${windowId}`;
      if (seen.has(key) || usage.length >= MAX_USAGE) continue;
      seen.add(key);
      usage.push({
        provider: name,
        window: windowId,
        usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
        resetsAt: resetsAtOf(window.resetsAt),
      });
    }
  }
  return usage;
}

/** The relay refuses a larger body with 413 `too_large`. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The `POST /facts` body. A heartbeat carries the full session set, so it is never split across
 * requests (a missing session reads as ended): over the body limit, the least recently active
 * sessions are left out until it fits.
 */
export function factsRequestBody<Machine extends { readonly policyFingerprint: string | null }>(
  machine: Machine,
  collected: FactsCollection,
) {
  const usage = collected.usage.length === 0 ? {} : { usage: collected.usage };
  const withActivity = (activity: ReadonlyArray<ActivityFact>) => ({
    machine: { ...machine, policyFingerprint: collected.policyFingerprint },
    activity,
    ...usage,
  });
  let activity = collected.activity.toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  let body = withActivity(activity);
  while (activity.length > 0 && Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    activity = activity.slice(0, Math.floor(activity.length * 0.9));
    body = withActivity(activity);
  }
  return body;
}

const encodePolicyJson = Schema.encodeEffect(Schema.fromJsonString(ManagedPolicyDocument));

/**
 * `sha256:` + the full digest of the bytes upstream's `loadedPolicy` hashes, so its 12-character
 * fingerprint (`t3 policy show`) is a prefix of this one. Null when no managed policy applies.
 */
const policyFingerprintOf = Effect.fn("BanneretFacts.policyFingerprint")(function* (
  policy: Pick<ManagedPolicy.ManagedPolicy["Service"], "document">,
) {
  if (policy.document === undefined) return null;
  const json = yield* encodePolicyJson(policy.document);
  return `sha256:${NodeCrypto.createHash("sha256").update(json, "utf8").digest("hex")}`;
});

const makeFromInputs = (inputs: FactsInputs) =>
  Effect.sync(() => {
    const sessions = new Map<string, string>();
    let lastActivity: ReadonlyArray<ActivityFact> = [];
    const readActivity = Effect.fn("BanneretFacts.activity")(function* (relayOrigin: string) {
      const projects = enterpriseProjects({
        workspaces: yield* inputs.workspaces,
        projects: yield* inputs.projects,
        relayOrigin,
        environmentId: inputs.environmentId,
      });
      if (projects.size === 0) {
        sessions.clear();
        return [];
      }
      const threads = yield* inputs.threads(new Set(projects.keys()));
      const providers = yield* inputs.providers;
      return buildActivity({ threads, projects, providers, sessions });
    });

    const collect = Effect.fn("BanneretFacts.collect")(function* (relayOrigin: string) {
      const activity = yield* readActivity(relayOrigin).pipe(
        Effect.tap((read) => Effect.sync(() => (lastActivity = read))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Banneret facts: activity read failed", cause).pipe(
            Effect.as(lastActivity),
          ),
        ),
      );
      const usage = yield* inputs.providers.pipe(
        Effect.map(buildUsage),
        Effect.orElseSucceed((): UsageFact[] => []),
      );
      const policyFingerprint = yield* inputs.policyFingerprint.pipe(
        Effect.orElseSucceed(() => null),
      );
      return { activity, usage, policyFingerprint };
    });
    return BanneretFacts.of({ collect });
  });

export const layerFromInputs = (inputs: FactsInputs) =>
  Layer.effect(BanneretFacts, makeFromInputs(inputs));

/** The server's facts, read through upstream's own services; no upstream file changes. */
export const layer = Layer.effect(
  BanneretFacts,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const projects = yield* ProjectService;
    const providers = yield* ProviderRegistry;
    const policy = yield* ManagedPolicy.ManagedPolicy;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof Workspaces.list>>>();
    const policyFingerprint = yield* policyFingerprintOf(policy).pipe(
      Effect.orElseSucceed(() => null),
    );
    return yield* makeFromInputs({
      environmentId,
      workspaces: Workspaces.list().pipe(
        Effect.map((list) => list.workspaces),
        Effect.provideContext(context),
      ),
      projects: projects.listShells().pipe(Effect.mapError(readError)),
      threads: Effect.fn("BanneretFacts.threads")(function* (projectIds) {
        // The index names each thread's project without building its shell, so threads of other
        // projects are never loaded.
        const ids = (yield* threads.listActiveShellIndex())
          .filter(
            (entry) =>
              projectIds.has(entry.projectId) &&
              entry.settledAt === null &&
              entry.settledOverride !== "settled",
          )
          .slice(0, MAX_THREAD_READ)
          .map((entry) => entry.id);
        if (ids.length === 0) return [];
        return (yield* threads.getShellSnapshot({ location: "active", threadIds: ids })).threads;
      }, Effect.mapError(readError)),
      providers: providers.getProviders,
      policyFingerprint: Effect.succeed(policyFingerprint),
    });
  }),
);
