import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { RunId, ThreadId } from "./baseSchemas.ts";

export const PauseAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["pause", "resume", "stopAll"]) }),
  Schema.Struct({ kind: Schema.Literal("stop"), threadId: ThreadId, runId: RunId }),
]);
export type PauseAction = typeof PauseAction.Type;
export const PauseStatus = Schema.Struct({
  paused: Schema.Boolean,
  held: Schema.Number,
  running: Schema.Array(Schema.Struct({ threadId: ThreadId, runId: RunId, title: Schema.String })),
});
export type PauseStatus = typeof PauseStatus.Type;
export const pauseRpcs = [
  Rpc.make("banneretPause.status", {
    payload: Schema.Struct({}),
    success: PauseStatus,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make("banneretPause.change", {
    payload: PauseAction,
    success: PauseStatus,
    error: EnvironmentAuthorizationError,
  }),
] as const;
