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
const reviewAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["confirm", "keep", "pin", "unpin", "refresh", "remove", "dismiss"]),
  }),
  Schema.Struct({
    kind: Schema.Literals(["edit", "editConfirm", "editKeep"]),
    text: bounded(4096),
  }),
  Schema.Struct({ kind: Schema.Literal("flag"), reason: bounded(512) }),
]);
export type MemoryReviewAction = typeof reviewAction.Type;
const reviewNote = Schema.Struct({
  key: Schema.String,
  text: Schema.String,
  kind: Schema.String,
  scope: Schema.String,
  trust: Schema.String,
  source: Schema.String,
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
export const MEMORY_RPCS = [
  Rpc.make("memory.summary", {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.NullOr(
      Schema.Struct({ total: Schema.Int, proposed: Schema.Int, disputed: Schema.Int }),
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
  "memory.review": AuthSettingsWriteScope,
  "memory.list": AuthOrchestrationOperateScope,
  "memory.summary": AuthOrchestrationOperateScope,
  "memory.getSetting": AuthOrchestrationReadScope,
  "memory.setSetting": AuthSettingsWriteScope,
} as const;

export const MEMORY_RPC_AGGREGATES = {
  "memory.review": "leases",
  "memory.list": "leases",
  "memory.summary": "leases",
  "memory.getSetting": "leases",
  "memory.setSetting": "leases",
} as const;
