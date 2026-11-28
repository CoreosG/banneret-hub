import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";
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
export const MEMORY_RPCS = [
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
] as const;

export const MEMORY_RPC_SCOPES = {
  "memory.repoSetting": AuthSettingsWriteScope,
  "memory.setRepo": AuthSettingsWriteScope,
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
  "memory.summary": AuthOrchestrationOperateScope,
  "memory.getSetting": AuthOrchestrationReadScope,
  "memory.setSetting": AuthSettingsWriteScope,
} as const;

export const MEMORY_RPC_AGGREGATES = {
  "memory.repoSetting": "leases",
  "memory.setRepo": "leases",
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
  "memory.summary": "leases",
  "memory.getSetting": "leases",
  "memory.setSetting": "leases",
} as const;
