import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ContextHandoffId, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "./orchestrationV2.ts";
import { ProviderDriverKind, type ProviderInstanceId } from "./providerInstance.ts";
import { TaskLeaseError } from "./taskLeases.ts";

const error = Schema.Union([EnvironmentAuthorizationError, TaskLeaseError]);
const bounded = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const conflictSource = Schema.Struct({
  key: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  text: Schema.String,
  source: Schema.String,
});
const contradiction = Schema.Struct({
  id: Schema.String,
  a: Schema.Struct({ ...conflictSource.fields, key: Schema.String, version: Schema.String }),
  b: conflictSource,
});
export type MemoryContradiction = typeof contradiction.Type;
const reviewAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["confirm", "keep", "pin", "unpin", "refresh", "remove", "dismiss"]),
  }),
  Schema.Struct({
    kind: Schema.Literals(["edit", "editConfirm", "editKeep"]),
    text: bounded(4096),
  }),
  Schema.Struct({
    kind: Schema.Literal("resolveConflict"),
    id: bounded(64),
    choice: Schema.Literals(["keepA", "keepB"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("scopeConflict"),
    id: bounded(64),
    scopeA: bounded(128),
    scopeB: bounded(128),
  }),
  Schema.Struct({ kind: Schema.Literal("editConflict"), id: bounded(64), text: bounded(4096) }),
  Schema.Struct({ kind: Schema.Literal("flag"), reason: bounded(512) }),
]);
export type MemoryReviewAction = typeof reviewAction.Type;
const reviewNote = Schema.Struct({
  previousSkill: Schema.optional(Schema.String),
  alternative: Schema.optional(Schema.String),
  key: Schema.String,
  text: Schema.String,
  kind: Schema.String,
  scope: Schema.String,
  trust: Schema.String,
  source: Schema.String,
  batch: Schema.optional(Schema.String),
  why: Schema.String,
  flaggedBy: Schema.String,
  reason: Schema.String,
  version: Schema.String,
});
export type MemoryReviewNote = typeof reviewNote.Type;
export const memoryReviewInput = Schema.Struct({
  threadId: ThreadId,
  key: Schema.String,
  version: Schema.String,
  action: reviewAction,
});
const preferences = Schema.Struct({
  folders: Schema.Array(bounded(4096)).check(Schema.isMaxLength(8)),
  nudges: Schema.Boolean,
  watcher: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      generator: Schema.String.check(Schema.isMaxLength(128)),
      model: Schema.String.check(Schema.isMaxLength(128)),
      muted: Schema.Array(bounded(96)).check(Schema.isMaxLength(256)),
    }),
  ),
});
export type MemoryPreferencesInput = typeof preferences.Type;
export const WorkflowJudgment = Schema.Struct({
  summary: bounded(1200),
  setup: Schema.NullOr(bounded(512)),
  rule: Schema.NullOr(bounded(512)),
  draft: Schema.NullOr(Schema.Struct({ title: bounded(120), body: bounded(1200) })),
});
const workflowReport = Schema.Struct({
  reviewing: Schema.optional(Schema.Boolean),
  judgment: Schema.optional(WorkflowJudgment),
  topRule: Schema.NullOr(Schema.String),
  topCount: Schema.Int,
  proposalKey: Schema.NullOr(Schema.String),
  failures: Schema.Int,
  waiting: Schema.Int,
  disputed: Schema.Int,
  corrections: Schema.Int,
  created: Schema.Int,
  retries: Schema.Int,
  proposed: Schema.Int,
  contested: Schema.Int,
  stale: Schema.Int,
  fired: Schema.Int,
  acknowledged: Schema.Int,
  pending: Schema.Boolean,
});
const workflowState = Schema.Struct({
  relayOrigin: Schema.optional(Schema.String),
  weekly: Schema.Boolean,
  report: Schema.NullOr(workflowReport),
});
const providerSwitchSide = Schema.Struct({
  name: Schema.String,
  /** False when the Hub cannot say which instruction files this provider reads. */
  integrated: Schema.Boolean,
  project: Schema.NullOr(Schema.String),
  personal: Schema.NullOr(Schema.String),
});
const switchNotice = Schema.Struct({
  from: providerSwitchSide,
  to: providerSwitchSide,
  /** Null when this chat's agent is not given the note index. */
  notes: Schema.NullOr(NonNegativeInt),
  /** How much of the earlier conversation the handoff took along, when it is recorded. */
  carried: Schema.NullOr(Schema.Struct({ items: NonNegativeInt, of: NonNegativeInt })),
});
export type SwitchNotice = typeof switchNotice.Type;
export type ProviderSwitchSide = typeof providerSwitchSide.Type;

/** The title the server gives a handoff made because the thread changed provider instance. */
const PROVIDER_HANDOFF_TITLE = "Provider handoff";
export const isProviderHandoff = (item: { readonly title?: string | null }) =>
  item.title === PROVIDER_HANDOFF_TITLE;

/**
 * The instances a provider handoff went between, or null for a fork, merge-back or recovery row.
 * Two instances can run the same provider, so the caller compares their drivers.
 */
export function providerHandoffEnds(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "title" | "status" | "runId" | "strategy" | "fromProviderInstanceIds" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "providerInstanceId">>,
): { from: ProviderInstanceId; to: ProviderInstanceId; resumed: boolean } | null {
  if (!isProviderHandoff(item) || item.status === "failed") return null;
  const to = item.toProviderInstanceId;
  // A retry also covers the target's own failed run, which is not where the thread came from.
  const sources = item.fromProviderInstanceIds.filter((id) => id !== to);
  const ordinal = runs.find((run) => run.id === item.runId)?.ordinal ?? Infinity;
  // The handoff lists its sources in first-use order. The latest run says which one was last.
  const last = runs
    .filter((run) => run.ordinal <= ordinal && sources.includes(run.providerInstanceId))
    .reduce<(typeof runs)[number] | undefined>(
      (best, run) => (best === undefined || run.ordinal > best.ordinal ? run : best),
      undefined,
    );
  const from = last?.providerInstanceId ?? sources.at(-1);
  return from === undefined
    ? null
    : { from, to, resumed: item.strategy === "delta_since_target_last_seen" };
}

export const MEMORY_RPCS = [
  Rpc.make("memory.workflow", {
    payload: Schema.Struct({
      threadId: ThreadId,
      action: Schema.Literals([
        "read",
        "run",
        "enable",
        "disable",
        "dismiss",
        "propose",
        "rule",
        "setup",
      ]),
      created: Schema.optional(Schema.Int),
    }),
    success: workflowState,
    error,
  }),
  Rpc.make("memory.workflowNeeds", {
    payload: Schema.Struct({ workspaceId: bounded(256) }),
    success: Schema.NullOr(ThreadId),
    error,
  }),
  Rpc.make("memory.repoSetting", {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Struct({
      url: Schema.String,
      projects: Schema.Boolean,
      enterprise: Schema.Boolean,
      status: Schema.String,
    }),
    error,
  }),
  Rpc.make("memory.setRepo", {
    payload: Schema.Struct({
      threadId: ThreadId,
      url: Schema.String.check(Schema.isMaxLength(2048)),
      projects: Schema.Boolean,
    }),
    success: Schema.String,
    error,
  }),
  Rpc.make("memory.sync", {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.String,
    error,
  }),
  Rpc.make("memory.preferences", {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: preferences,
    error,
  }),
  Rpc.make("memory.configure", {
    payload: Schema.Struct({ threadId: ThreadId, ...preferences.fields }),
    success: Schema.Void,
    error,
  }),
  Rpc.make("memory.confirmImport", {
    payload: Schema.Struct({
      threadId: ThreadId,
      batch: bounded(64),
      notes: Schema.Array(Schema.Struct({ key: bounded(96), version: bounded(64) })),
    }),
    success: Schema.Void,
    error,
  }),
  Rpc.make("memory.importFile", {
    payload: Schema.Struct({
      threadId: ThreadId,
      name: bounded(255),
      content: bounded(65536),
      batch: bounded(64),
    }),
    success: Schema.Struct({ proposed: Schema.Int, skipped: Schema.Int, reason: Schema.String }),
    error,
  }),
  Rpc.make("memory.exportFiles", {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.String })),
    error,
  }),
  Rpc.make("memory.targets", {
    payload: Schema.Struct({}),
    success: Schema.Array(ThreadId),
    error,
  }),
  Rpc.make("memory.switchNotice", {
    payload: Schema.Struct({
      threadId: ThreadId,
      from: ProviderDriverKind,
      to: ProviderDriverKind,
      /** The handoff a switch recorded. Left out while the switch is only picked. */
      handoffId: Schema.optional(ContextHandoffId),
    }),
    success: switchNotice,
    error,
  }),
  Rpc.make("memory.summary", {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.NullOr(
      Schema.Struct({
        reminders: Schema.optional(
          Schema.Struct({
            contradictions: Schema.optional(Schema.Array(contradiction)),
            fired: Schema.Int,
            acknowledged: Schema.Int,
            contested: Schema.Int,
            latest: Schema.Array(
              Schema.Struct({
                key: Schema.String,
                text: Schema.String,
                source: Schema.String,
                trust: Schema.String,
              }),
            ),
          }),
        ),
        main: Schema.optional(Schema.Boolean),
        cardsOnly: Schema.optional(Schema.Boolean),
        total: Schema.Int,
        proposed: Schema.Int,
        disputed: Schema.Int,
      }),
    ),
    error,
  }),
  Rpc.make("memory.skills", {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        layer: Schema.String,
        locked: Schema.Boolean,
        trust: Schema.String,
      }),
    ),
    error,
  }),
  Rpc.make("memory.list", {
    payload: Schema.Struct({ threadId: ThreadId, pendingOnly: Schema.Boolean }),
    success: Schema.Array(reviewNote),
    error,
  }),
  Rpc.make("memory.review", { payload: memoryReviewInput, success: Schema.Void, error }),
  Rpc.make("memory.getSetting", { payload: Schema.Struct({}), success: Schema.Boolean, error }),
  Rpc.make("memory.setSetting", {
    payload: Schema.Struct({ enabled: Schema.Boolean }),
    success: Schema.Boolean,
    error,
  }),
  Rpc.make("skills.getSetting", { payload: Schema.Struct({}), success: Schema.Boolean, error }),
  Rpc.make("skills.setSetting", {
    payload: Schema.Struct({ enabled: Schema.Boolean }),
    success: Schema.Boolean,
    error,
  }),
] as const;

export const MEMORY_RPC_SCOPES = {
  "memory.repoSetting": AuthSettingsWriteScope,
  "memory.setRepo": AuthSettingsWriteScope,
  "memory.workflow": AuthSettingsWriteScope,
  "memory.workflowNeeds": AuthSettingsWriteScope,
  "memory.sync": AuthSettingsWriteScope,
  "memory.configure": AuthSettingsWriteScope,
  "memory.preferences": AuthSettingsWriteScope,
  "memory.confirmImport": AuthSettingsWriteScope,
  "memory.importFile": AuthSettingsWriteScope,
  "memory.exportFiles": AuthSettingsWriteScope,
  "memory.targets": AuthSettingsWriteScope,
  "memory.review": AuthSettingsWriteScope,
  "memory.skills": AuthOrchestrationOperateScope,
  "memory.list": AuthOrchestrationOperateScope,
  "memory.switchNotice": AuthOrchestrationOperateScope,
  "memory.summary": AuthOrchestrationOperateScope,
  "memory.getSetting": AuthOrchestrationReadScope,
  "memory.setSetting": AuthSettingsWriteScope,
  "skills.getSetting": AuthOrchestrationReadScope,
  "skills.setSetting": AuthSettingsWriteScope,
} as const;

export const MEMORY_RPC_AGGREGATES = {
  "memory.repoSetting": "leases",
  "memory.setRepo": "leases",
  "memory.workflow": "leases",
  "memory.workflowNeeds": "leases",
  "memory.sync": "leases",
  "memory.configure": "leases",
  "memory.preferences": "leases",
  "memory.confirmImport": "leases",
  "memory.importFile": "leases",
  "memory.exportFiles": "leases",
  "memory.targets": "leases",
  "memory.review": "leases",
  "memory.skills": "leases",
  "memory.list": "leases",
  "memory.switchNotice": "leases",
  "memory.summary": "leases",
  "memory.getSetting": "leases",
  "memory.setSetting": "leases",
  "skills.getSetting": "leases",
  "skills.setSetting": "leases",
} as const;
