// Banneret Hub: every TCP port listening on an environment's host, for the Ports panel.
// Upstream's port discovery lists only servers a thread started; this lists them all.
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";

export const BANNERET_PORTS_WS_METHODS = {
  list: "banneretPorts.list",
} as const;

export const ListeningPort = Schema.Struct({
  port: Schema.Number,
  pid: Schema.NullOr(Schema.Number),
  processName: Schema.NullOr(Schema.String),
  /** Bound to loopback only, versus all interfaces (reachable from the LAN or tailnet). */
  loopbackOnly: Schema.Boolean,
});
export type ListeningPort = typeof ListeningPort.Type;

export const ListeningPortsResult = Schema.Struct({
  ports: Schema.Array(ListeningPort),
  /** The environment server's own port; it cannot be forwarded through itself. */
  serverPort: Schema.NullOr(Schema.Number),
});
export type ListeningPortsResult = typeof ListeningPortsResult.Type;

export const WsBanneretPortsListRpc = Rpc.make(BANNERET_PORTS_WS_METHODS.list, {
  payload: Schema.Struct({}),
  success: ListeningPortsResult,
  error: EnvironmentAuthorizationError,
});
