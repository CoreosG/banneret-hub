import { PLUGIN_RPCS, PLUGIN_SCOPES, PLUGIN_AGGREGATES } from "./banneretPlugins.ts";
// Banneret Hub: enrolment of this server environment in a company relay (docs/banneret/relay-v1).
// The server holds the machine key and device token and makes every relay call; clients see only
// the view below, which never carries either.
import {
  SandboxAction,
  SandboxReceipt,
  WorkspaceReceipt,
  FolderSizes,
  PoolResources,
  ResourceReport,
  WarningPolicy,
} from "./banneretResources.ts";
import { OfficeEdit, OfficeSharing, OfficeHeartbeats } from "./banneretOffice.ts";
export * from "./banneretOffice.ts";
import { PoolFounderAction, PoolFounderView } from "./banneretPoolFounder.ts";
export * from "./banneretPoolFounder.ts";
export * from "./banneretResources.ts";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BANNERET_RELAY_FEED_RPCS,
  BANNERET_RELAY_FEED_RPC_AGGREGATES,
  BANNERET_RELAY_FEED_RPC_SCOPES,
} from "./banneretRelayFeed.ts";

import { MEMORY_RPCS, MEMORY_RPC_SCOPES, MEMORY_RPC_AGGREGATES } from "./banneretMemory.ts";
import { TASK_LEASE_RPCS, TASK_LEASE_RPC_AGGREGATES, TASK_LEASE_RPC_SCOPES } from "./taskLeases.ts";

export * from "./banneretRelayFeed.ts";
export * from "./banneretChat.ts";
// Take and release are not relay calls, but they share the relay's one hook into the RPC group.
export * from "./taskLeases.ts";
export * from "./leaseProtocol.ts";

export const BANNERET_RELAY_WS_METHODS = {
  resources: "banneret.resources",
  folders: "banneret.resourceFolders",
  sandbox: "banneret.sandbox",
  requestWorkspace: "banneret.requestWorkspace",
  officeEdit: "banneret.officeEdit",
  officeHeard: "banneret.officeHeard",
  poolFounder: "banneret.poolFounder",
  pool: "banneret.poolResources",
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
  /** The relay knows neither this machine's token nor its id: its store was reset, or it was removed. */
  "unknown_machine",
  "forbidden",
  "invalid_reply",
]);
export type BanneretRelayHealth = typeof BanneretRelayHealth.Type;

type Presence = "available" | "focusing" | "away" | "off";
export interface TeamPresenceValues {
  presence: Presence;
  status?: { text: string };
  seatBoard?: string;
}
export interface TeamPresenceEdit {
  presence?: Presence;
  status?: { text: string } | null;
  seatBoard?: string | null;
}

export const BanneretMachineKind = Schema.Literals(["laptop", "desktop", "server", "cloud"]);
export type BanneretMachineKind = typeof BanneretMachineKind.Type;

/** The machine label pattern of the relay contract (MachineFacts.label). */
export const BANNERET_MACHINE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export const BanneretEnrolmentView = Schema.Struct({
  state: BanneretEnrolmentState,
  /** The Enterprise workspace this enrolment belongs to: `ent-` + 16 hex of sha256(origin). */
  workspaceId: Schema.String,
  /** The relay this enrolment is with. A machine has one enrolment per relay. */
  relayOrigin: Schema.String,
  displayName: Schema.optional(Schema.String),
  /** The relay's id for this join, while it is pending or approved: what `pairings list` shows. */
  pairingId: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  sharing: Schema.optional(OfficeSharing),
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

/** What this environment tells every relay about itself: the facts support matches a join by. */
export const BanneretEnrolmentMachine = Schema.Struct({
  poolHostId: Schema.optional(Schema.String),
  environmentId: Schema.String,
  hostname: Schema.String,
  hubVersion: Schema.String,
});
export type BanneretEnrolmentMachine = typeof BanneretEnrolmentMachine.Type;

/** Every relay this environment has joined, is joining, or last tried. */
export const BanneretEnrolmentList = Schema.Struct({
  enrolments: Schema.Array(BanneretEnrolmentView),
  machine: BanneretEnrolmentMachine,
});
export type BanneretEnrolmentList = typeof BanneretEnrolmentList.Type;

/** Which relay a call is for; the server reduces it to its origin. */
const RelayTarget = { relayOrigin: Schema.String };

export const BanneretRelayProbeResult = Schema.Struct({
  origin: Schema.String,
  displayName: Schema.String,
});
export type BanneretRelayProbeResult = typeof BanneretRelayProbeResult.Type;

export const BanneretRelayMachine = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.String,
  hostname: Schema.String,
  os: Schema.String,
  poolHostId: Schema.optional(Schema.String),
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
  success: BanneretEnrolmentList,
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
  payload: Schema.Struct(RelayTarget),
  success: BanneretEnrolmentView,
  error: RelayRpcError,
});

/**
 * `revoke` tells the relay first; `forget` is offered only while the relay cannot be reached, and
 * is the only way out of `approved` besides `cancel`.
 */
const WsBanneretRelayLeaveRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.leave, {
  payload: Schema.Struct({
    ...RelayTarget,
    mode: Schema.Literals(["revoke", "forget"]),
    keepWorkspace: Schema.Boolean,
  }),
  success: BanneretEnrolmentView,
  error: RelayRpcError,
});

const WsBanneretRelayMachinesRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.machines, {
  payload: Schema.Struct({ ...RelayTarget, cursor: Schema.optional(Schema.String) }),
  success: BanneretRelayMachinesPage,
  error: RelayRpcError,
});

const WsBanneretRelayRevokeMachineRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.revokeMachine, {
  payload: Schema.Struct({ ...RelayTarget, machineId: Schema.String }),
  success: Schema.Struct({}),
  error: RelayRpcError,
});

/**
 * Which of the given git remotes name a repository in the company's list. The remotes go only to
 * this server, which hashes them into project keys; the relay never sees a remote or a path.
 */
const WsBanneretRelayMatchProjectsRpc = Rpc.make(BANNERET_RELAY_WS_METHODS.matchProjects, {
  payload: Schema.Struct({ ...RelayTarget, remoteUrls: Schema.Array(Schema.String) }),
  success: Schema.Struct({ matched: Schema.Array(Schema.String) }),
  error: RelayRpcError,
});

/** Spread into `WsRpcGroup`. */
export const BANNERET_RELAY_RPCS = [
  Rpc.make(BANNERET_RELAY_WS_METHODS.resources, {
    payload: Schema.Struct({ policy: Schema.optional(WarningPolicy) }),
    success: ResourceReport,
    error: RelayRpcError,
  }),
  Rpc.make(BANNERET_RELAY_WS_METHODS.folders, {
    payload: Schema.Struct({}),
    success: FolderSizes,
    error: RelayRpcError,
  }),
  Rpc.make(BANNERET_RELAY_WS_METHODS.sandbox, {
    payload: Schema.Struct({ ...RelayTarget, action: SandboxAction }),
    success: SandboxReceipt,
    error: RelayRpcError,
  }),
  Rpc.make(BANNERET_RELAY_WS_METHODS.requestWorkspace, {
    payload: Schema.Struct({ ...RelayTarget, hostId: Schema.String }),
    success: WorkspaceReceipt,
    error: RelayRpcError,
  }),
  Rpc.make(BANNERET_RELAY_WS_METHODS.officeEdit, {
    payload: Schema.Struct({ ...RelayTarget, action: OfficeEdit }),
    success: Schema.Void,
    error: RelayRpcError,
  }),
  Rpc.make(BANNERET_RELAY_WS_METHODS.officeHeard, {
    payload: Schema.Struct({ ...RelayTarget, ids: Schema.Array(Schema.String) }),
    success: OfficeHeartbeats,
    error: RelayRpcError,
  }),
  Rpc.make(BANNERET_RELAY_WS_METHODS.poolFounder, {
    payload: Schema.Struct({ ...RelayTarget, action: Schema.optional(PoolFounderAction) }),
    success: PoolFounderView,
    error: RelayRpcError,
  }),
  Rpc.make(BANNERET_RELAY_WS_METHODS.pool, {
    payload: Schema.Struct(RelayTarget),
    success: PoolResources,
    error: RelayRpcError,
  }),
  WsBanneretRelayProbeRpc,
  WsBanneretRelayStatusRpc,
  WsBanneretRelayStartRpc,
  WsBanneretRelayCancelRpc,
  WsBanneretRelayLeaveRpc,
  WsBanneretRelayMachinesRpc,
  WsBanneretRelayRevokeMachineRpc,
  WsBanneretRelayMatchProjectsRpc,
  ...BANNERET_RELAY_FEED_RPCS,
  ...MEMORY_RPCS,
  ...PLUGIN_RPCS,
  ...TASK_LEASE_RPCS,
] as const;

/** Spread into `CLIENT_GUARDED_RPC_SCOPES`. Probing dials an address the user typed. */
export const BANNERET_RELAY_RPC_SCOPES = {
  [BANNERET_RELAY_WS_METHODS.resources]: AuthDiagnosticsReadScope,
  [BANNERET_RELAY_WS_METHODS.folders]: AuthFilesystemReadScope,
  [BANNERET_RELAY_WS_METHODS.officeEdit]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.officeHeard]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.poolFounder]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.pool]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_WS_METHODS.sandbox]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_WS_METHODS.requestWorkspace]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_WS_METHODS.probe]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.status]: AuthOrchestrationReadScope,
  [BANNERET_RELAY_WS_METHODS.start]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.cancel]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.leave]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.machines]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_WS_METHODS.revokeMachine]: AuthEnvironmentMaintainScope,
  [BANNERET_RELAY_WS_METHODS.matchProjects]: AuthOrchestrationOperateScope,
  ...BANNERET_RELAY_FEED_RPC_SCOPES,
  ...MEMORY_RPC_SCOPES,
  ...PLUGIN_SCOPES,
  ...TASK_LEASE_RPC_SCOPES,
} as const;

/** Spread into the server's `RPC_AGGREGATES`. */
export const BANNERET_RELAY_RPC_AGGREGATES = {
  [BANNERET_RELAY_WS_METHODS.resources]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.folders]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.officeEdit]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.officeHeard]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.poolFounder]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.pool]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.sandbox]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.requestWorkspace]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.probe]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.status]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.start]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.cancel]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.leave]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.machines]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.revokeMachine]: "banneret-relay",
  [BANNERET_RELAY_WS_METHODS.matchProjects]: "banneret-relay",
  ...BANNERET_RELAY_FEED_RPC_AGGREGATES,
  ...MEMORY_RPC_AGGREGATES,
  ...PLUGIN_AGGREGATES,
  ...TASK_LEASE_RPC_AGGREGATES,
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

export type * from "./banneretPool.ts";

export {
  memoryReviewInput,
  type MemoryReviewAction,
  type MemoryReviewNote,
  type MemoryPreferencesInput,
} from "./banneretMemory.ts";
