import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AuthEnvironmentMaintainScope, EnvironmentAuthorizationError } from "./auth.ts";
import { TaskLeaseError } from "./taskLeases.ts";

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
export const PLUGIN_RPCS = [
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
  "plugins.list": AuthEnvironmentMaintainScope,
  "plugins.add": AuthEnvironmentMaintainScope,
  "plugins.remove": AuthEnvironmentMaintainScope,
} as const;
export const PLUGIN_AGGREGATES = {
  "plugins.list": "banneret-plugins",
  "plugins.add": "banneret-plugins",
  "plugins.remove": "banneret-plugins",
} as const;
