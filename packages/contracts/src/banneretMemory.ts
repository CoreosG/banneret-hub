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
export const MEMORY_RPCS = [
  Rpc.make("memory.summary", {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.NullOr(
      Schema.Struct({ total: Schema.Int, proposed: Schema.Int, disputed: Schema.Int }),
    ),
    error,
  }),
  Rpc.make("memory.getSetting", { payload: Schema.Struct({}), success: Schema.Boolean, error }),
  Rpc.make("memory.setSetting", {
    payload: Schema.Struct({ enabled: Schema.Boolean }),
    success: Schema.Boolean,
    error,
  }),
] as const;

export const MEMORY_RPC_SCOPES = {
  "memory.summary": AuthOrchestrationOperateScope,
  "memory.getSetting": AuthOrchestrationReadScope,
  "memory.setSetting": AuthSettingsWriteScope,
} as const;

export const MEMORY_RPC_AGGREGATES = {
  "memory.summary": "leases",
  "memory.getSetting": "leases",
  "memory.setSetting": "leases",
} as const;
