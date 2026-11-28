import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AuthEnvironmentMaintainScope, EnvironmentAuthorizationError } from "./auth.ts";
import { TaskLeaseError } from "./taskLeases.ts";

import { ThreadId } from "./baseSchemas.ts";
export const ToolLevel = Schema.Literals(["none", "read", "read_write"]);
export type ToolLevel = typeof ToolLevel.Type;
const thread = { threadId: ThreadId };
const levels = {
  success: Schema.Array(Schema.Struct({ source: Schema.String, level: ToolLevel })),
  error: Schema.Union([EnvironmentAuthorizationError, TaskLeaseError]),
};

const workspace = { workspaceId: Schema.NonEmptyString };
const summary = Schema.Struct({
  source: Schema.String,
  description: Schema.String,
  capabilities: Schema.Array(Schema.String),
  auth: Schema.String,
  endpoint: Schema.String,
});
const result = {
  success: Schema.Array(summary),
  error: Schema.Union([EnvironmentAuthorizationError, TaskLeaseError]),
};
export const CallApproval = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.String,
  sensitive: Schema.Boolean,
  source: Schema.String,
  name: Schema.String,
  args: Schema.String,
  allowAlways: Schema.Boolean,
  state: Schema.Literals(["pending", "running", "ran", "failed", "refused", "expired", "unknown"]),
  actor: Schema.String,
  reason: Schema.String,
});
export type CallApproval = typeof CallApproval.Type;
/**
 * A copy of a company server in the person's own agent settings, as a chat's latest agent session met
 * it. `off` is false when the Hub could not turn it off.
 */
export const OwnCopy = Schema.Struct({
  settings: Schema.Literals(["Claude", "Codex"]),
  off: Schema.Boolean,
});
export type OwnCopy = typeof OwnCopy.Type;
/** One company source and this machine's sign-in to it. No token is part of it. */
export const SourceSignIn = Schema.Struct({
  relayOrigin: Schema.String,
  company: Schema.String,
  sourceId: Schema.String,
  title: Schema.String,
  /** The host a sign-in is sent to. */
  address: Schema.String,
  auth: Schema.Literals(["none", "oauth", "bearer_per_person"]),
  state: Schema.Literals(["network", "signed_in", "signed_out", "expired", "refused"]),
  /** Where a person gets a token. */
  help: Schema.optionalKey(Schema.String),
  /** The sign-in page, while one is waiting. */
  authorizationUrl: Schema.optionalKey(Schema.String),
  /** Only in a thread's rows, and only when the person has such a copy. */
  ownCopy: Schema.optionalKey(OwnCopy),
});
export type SourceSignIn = typeof SourceSignIn.Type;
const signInTarget = { relayOrigin: Schema.NonEmptyString, sourceId: Schema.NonEmptyString };
/** What a person does about one sign-in. A pasted token or address travels redacted. */
export const SignInAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("start"), ...signInTarget }),
  Schema.Struct({
    kind: Schema.Literal("finish"),
    callbackUrl: Schema.RedactedFromValue(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("token"),
    ...signInTarget,
    token: Schema.RedactedFromValue(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("sign_out"), ...signInTarget }),
]);
export type SignInAction = typeof SignInAction.Type;

export const PLUGIN_RPCS = [
  Rpc.make("plugins.signIns", {
    stream: true,
    payload: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
    success: Schema.Array(SourceSignIn),
    error: levels.error,
  }),
  // One command for every action: the server's RPC group is near the compiler's type depth limit.
  Rpc.make("plugins.signIn", {
    payload: Schema.Struct({ action: SignInAction }),
    success: Schema.Void,
    error: levels.error,
  }),
  Rpc.make("plugins.approvals", {
    stream: true,
    payload: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
    success: Schema.Array(CallApproval),
    error: levels.error,
  }),
  Rpc.make("plugins.decide", {
    payload: Schema.Struct({
      id: Schema.NonEmptyString,
      choice: Schema.Literals(["once", "always", "refuse"]),
      reason: Schema.String,
    }),
    success: CallApproval,
    error: levels.error,
  }),
  Rpc.make("plugins.levels", { payload: Schema.Struct(thread), ...levels }),
  Rpc.make("plugins.setLevel", {
    payload: Schema.Struct({ ...thread, source: Schema.NonEmptyString, level: ToolLevel }),
    ...levels,
  }),
  Rpc.make("plugins.list", { payload: Schema.Struct(workspace), ...result }),
  Rpc.make("plugins.add", {
    payload: Schema.Struct({
      ...workspace,
      endpoint: Schema.NonEmptyString,
      manifestUrl: Schema.optional(Schema.String),
      token: Schema.RedactedFromValue(Schema.String),
    }),
    ...result,
  }),
  Rpc.make("plugins.remove", {
    payload: Schema.Struct({ ...workspace, source: Schema.String }),
    ...result,
  }),
] as const;
export const PLUGIN_SCOPES = {
  "plugins.signIns": AuthEnvironmentMaintainScope,
  "plugins.signIn": AuthEnvironmentMaintainScope,
  "plugins.approvals": AuthEnvironmentMaintainScope,
  "plugins.decide": AuthEnvironmentMaintainScope,
  "plugins.levels": AuthEnvironmentMaintainScope,
  "plugins.setLevel": AuthEnvironmentMaintainScope,
  "plugins.list": AuthEnvironmentMaintainScope,
  "plugins.add": AuthEnvironmentMaintainScope,
  "plugins.remove": AuthEnvironmentMaintainScope,
} as const;
export const PLUGIN_AGGREGATES = {
  "plugins.signIns": "banneret-plugins",
  "plugins.signIn": "banneret-plugins",
  "plugins.approvals": "banneret-plugins",
  "plugins.decide": "banneret-plugins",
  "plugins.levels": "banneret-plugins",
  "plugins.setLevel": "banneret-plugins",
  "plugins.list": "banneret-plugins",
  "plugins.add": "banneret-plugins",
  "plugins.remove": "banneret-plugins",
} as const;
