// Banneret Hub: enrolment of this server environment in a company relay (docs/banneret/relay-v1).
// The server holds the machine key and device token and makes every relay call; clients see only
// the view below, which never carries either.
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";

export const BANNERET_RELAY_WS_METHODS = {
  probe: "banneretRelay.probe",
  status: "banneretRelay.status",
  start: "banneretRelay.start",
  cancel: "banneretRelay.cancel",
  leave: "banneretRelay.leave",
  machines: "banneretRelay.machines",
  revokeMachine: "banneretRelay.revokeMachine",
  matchProjects: "banneretRelay.matchProjects",
} as const;

/** A relay refused, could not be reached, or the request does not fit the current state. */
export class BanneretRelayError extends Schema.TaggedError<BanneretRelayError>()(
  "BanneretRelayError",
  { message: Schema.String },
) {}

const RelayRpcError = Schema.Union([EnvironmentAuthorizationError, BanneretRelayError]);

export const BanneretEnrolmentState = Schema.Literals([
  "none",
  "requested",
  "awaiting_approval",
  "approved",
  "configured",
  "revoked",
]);
export type BanneretEnrolmentState = typeof BanneretEnrolmentState.Type;

/** Run-time health of an `approved` or `configured` enrolment; never persisted. */
export const BanneretRelayHealth = Schema.Literals([
  "healthy",
  "unreachable",
  "clock_wrong",
  "refused",
  "forbidden",
  "invalid_reply",
]);
export type BanneretRelayHealth = typeof BanneretRelayHealth.Type;

export const BanneretMachineKind = Schema.Literals(["laptop", "desktop", "server", "cloud"]);
export type BanneretMachineKind = typeof BanneretMachineKind.Type;

/** The machine label pattern of the relay contract (MachineFacts.label). */
export const BANNERET_MACHINE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export const BanneretEnrolmentView = Schema.Struct({
  state: BanneretEnrolmentState,
  /** The Enterprise workspace this enrolment belongs to: `ent-` + 16 hex of sha256(origin). */
  workspaceId: Schema.optional(Schema.String),
  relayOrigin: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  confirmCode: Schema.optional(Schema.String),
  browserUrl: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  /** Why the last enrolment ended, or why this machine was revoked: a relay reason code. */
  reason: Schema.optional(Schema.String),
  /** The same in plain words. */
  message: Schema.optional(Schema.String),
  me: Schema.optional(Schema.Struct({ login: Schema.String, role: Schema.String })),
  replacedLabel: Schema.optional(Schema.String),
  health: Schema.optional(BanneretRelayHealth),
  lastOkAt: Schema.optional(Schema.String),
  unreachableSince: Schema.optional(Schema.String),
});
export type BanneretEnrolmentView = typeof BanneretEnrolmentView.Type;

export const BanneretRelayProbeResult = Schema.Struct({
  origin: Schema.String,
  displayName: Schema.String,
  protocol: Schema.String,
});
export type BanneretRelayProbeResult = typeof BanneretRelayProbeResult.Type;

export const BanneretRelayMachine = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.String,
  hostname: Schema.String,
  os: Schema.String,
  ownerLogin: Schema.String,
  connected: Schema.Boolean,
  lastHeardAt: Schema.NullOr(Schema.String),
  revocable: Schema.Boolean,
  revokedAt: Schema.optional(Schema.String),
  thisMachine: Schema.Boolean,
});
export type BanneretRelayMachine = typeof BanneretRelayMachine.Type;

export const BanneretRelayMachinesPage = Schema.Struct({
  items: Schema.Array(BanneretRelayMachine),
  nextCursor: Schema.NullOr(Schema.String),
});
export type BanneretRelayMachinesPage = typeof BanneretRelayMachinesPage.Type;

const WsBanneretRelayProbeRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.probe, {
  payload: Schema.Struct({ origin: Schema.String }),
  success: BanneretRelayProbeResult,
  error: RelayRpcError,
});

const WsBanneretRelayStatusRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.status, {
  payload: Schema.Struct({}),
  success: BanneretEnrolmentView,
  error: EnvironmentAuthorizationError,
});

const WsBanneretRelayStartRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.start, {
  payload: Schema.Struct({
    origin: Schema.String,
    label: Schema.String,
    kind: BanneretMachineKind,
  }),
  success: BanneretEnrolmentView,
  error: RelayRpcError,
});

const WsBanneretRelayCancelRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.cancel, {
  payload: Schema.Struct({}),
  success: BanneretEnrolmentView,
  error: RelayRpcError,
});

/**
 * `revoke` tells the relay first; `forget` is offered only while the relay cannot be reached, and
 * is the only way out of `approved` besides `cancel`.
 */
const WsBanneretRelayLeaveRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.leave, {
  payload: Schema.Struct({ mode: Schema.Literals(["revoke", "forget"]) }),
  success: BanneretEnrolmentView,
  error: RelayRpcError,
});

const WsBanneretRelayMachinesRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.machines, {
  payload: Schema.Struct({ cursor: Schema.optional(Schema.String) }),
  success: BanneretRelayMachinesPage,
  error: RelayRpcError,
});

const WsBanneretRelayRevokeMachineRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.revokeMachine, {
  payload: Schema.Struct({ machineId: Schema.String }),
  success: Schema.Struct({}),
  error: RelayRpcError,
});

/**
 * Which of the given git remotes name a repository in the company's list. The remotes go only to
 * this server, which hashes them into project keys; the relay never sees a remote or a path.
 */
const WsBanneretRelayMatchProjectsRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.matchProjects, {
  payload: Schema.Struct({ remoteUrls: Schema.Array(Schema.String) }),
  success: Schema.Struct({ matched: Schema.Array(Schema.String) }),
  error: RelayRpcError,
});

/** Spread into `WsRpcGroup`. */
export const BANNERET_RELAY_RPCS = [
  WsBanneretRelayProbeRpc,
  WsBanneretRelayStatusRpc,
  WsBanneretRelayStartRpc,
  WsBanneretRelayCancelRpc,
  WsBanneretRelayLeaveRpc,
  WsBanneretRelayMachinesRpc,
  WsBanneretRelayRevokeMachineRpc,
  WsBanneretRelayMatchProjectsRpc,
] as const;

/** Spread into `CLIENT_GUARDED_RPC_SCOPES`. Probing dials an address the user typed. */
export const BANNERET_RELAY_RPC_SCOPES = {
  [BANNERET_RELAY_WS_METHODS.probe]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.status]: AuthOrchestrationReadScope,
  [BANNERET_RELAY_WS_METHODS.start]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.cancel]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.leave]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.machines]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_WS_METHODS.revokeMachine]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.matchProjects]: AuthOrchestrationOperateScope,
} as const;

/** Spread into the server's `RPC_AGGREGATES`. */
export const BANNERET_RELAY_RPC_AGGREGATES = {
  [BANNERET_RELAY_WS_METHODS.probe]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.status]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.start]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.cancel]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.leave]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.machines]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.revokeMachine]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.matchProjects]: "banneret-relay",
} as const;

export type BanneretRelayAddress =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly message: string };

const LOOPBACK_HOSTS = new Set(["localhost", "[::1]"]);
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

/**
 * A relay address reduced to its origin. https only; plain http only on loopback (the fake relay in
 * tests). No credentials, path, query or fragment.
 */
export function parseBanneretRelayAddress(input: string): BanneretRelayAddress {
  const text = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: "That is not a web address." };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "The address must not contain a user name or password." };
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    return { ok: false, message: "Enter only the relay's address, without a path." };
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || IPV4_LOOPBACK.test(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    return { ok: false, message: "The relay must use https." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "The relay must use https." };
  }
  return { ok: true, origin: url.origin };
}
