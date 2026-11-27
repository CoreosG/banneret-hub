// Take and release a task on its work tracker (docs/banneret/relay-v1/README.md, "Lease protocol"). The server
// writes the claim and release comments, the assignee and the `claimed` label on the person's own tracker login;
// clients and agent tools only call these methods. Nothing is stored: every answer is read back from the tracker.
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { IssueRef } from "./issue.ts";
import { LEASE_RELEASE_REASONS } from "./leaseProtocol.ts";

export const TASK_LEASE_WS_METHODS = {
  memorySummary: "memory.summary",
  sandboxHandoff: "leases.sandboxHandoff",
  orchestrator: "leases.orchestrator",
  check: "leases.check",
  take: "leases.take",
  release: "leases.release",
  finish: "leases.finish",
  withdraw: "leases.withdraw",
} as const;

/**
 * Why take and release cannot run here. `unsupported`: the tracker cannot comment, label and assign.
 * `read-only`: the issue is outside the project's own scopes. `signed-out`: no tracker login.
 * `no-permission`: the login lacks triage access. `wrong-account`: the tracker login is not the person the
 * relay knows.
 */
export const TaskLeaseAvailability = Schema.Literals([
  "available",
  "unsupported",
  "read-only",
  "signed-out",
  "no-permission",
  "wrong-account",
]);
export type TaskLeaseAvailability = typeof TaskLeaseAvailability.Type;

/** The folded lease: `active`, `conflict` or `incomplete`. Logins as the tracker writes them. */
export const TaskLease = Schema.Struct({
  holder: Schema.String,
  state: Schema.String,
  since: Schema.NullOr(Schema.String),
  claimants: Schema.Array(Schema.String),
});
export type TaskLease = typeof TaskLease.Type;

export const TaskLeaseLastRelease = Schema.Struct({
  by: Schema.String,
  at: Schema.String,
  reason: Schema.String,
  freeToContinue: Schema.Boolean,
  reasonText: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});
export type TaskLeaseLastRelease = typeof TaskLeaseLastRelease.Type;

export const TaskLeaseStatus = Schema.Struct({
  availability: TaskLeaseAvailability,
  /** One plain sentence when take and release are unavailable. */
  detail: Schema.optional(Schema.String),
  /** The tracker login writes are made as. */
  viewer: Schema.NullOr(Schema.String),
  lease: Schema.NullOr(TaskLease),
  lastRelease: Schema.NullOr(TaskLeaseLastRelease),
  /** What the viewer can do now. */
  actions: Schema.Struct({
    take: Schema.Boolean,
    release: Schema.Boolean,
    finish: Schema.Boolean,
    withdraw: Schema.Boolean,
  }),
  /** An operation on this task is running on this server. */
  busy: Schema.Boolean,
});
export type TaskLeaseStatus = typeof TaskLeaseStatus.Type;

/**
 * `taken` and `released` finished every step. `lost`: someone claimed first, and the claim was withdrawn.
 * `withdrawn`: the operation was undone on the tracker. `incomplete`: a step failed after the comment was
 * written, so the tracker shows a half-done lease until Finish or Withdraw. `detail` says what happened.
 */
export const TaskLeaseOutcome = Schema.Literals([
  "taken",
  "lost",
  "released",
  "withdrawn",
  "incomplete",
]);
export type TaskLeaseOutcome = typeof TaskLeaseOutcome.Type;

export const TaskLeaseResult = Schema.Struct({
  orchestratorThreadId: Schema.optional(ThreadId),
  outcome: TaskLeaseOutcome,
  detail: Schema.optional(Schema.String),
  status: TaskLeaseStatus,
});
export type TaskLeaseResult = typeof TaskLeaseResult.Type;

/**
 * Refused before anything was written (`unavailable`, `refused`, `busy`, `invalid`), or the first write failed
 * (`failed`), so the tracker is unchanged.
 */
export class TaskLeaseError extends Schema.TaggedError<TaskLeaseError>()("TaskLeaseError", {
  reason: Schema.Literals(["unavailable", "refused", "busy", "invalid", "failed"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const LeaseRpcError = Schema.Union([EnvironmentAuthorizationError, TaskLeaseError]);

/**
 * A task's issue, and the relay whose person acts on it: that relay's `me` decides the account and
 * founder checks. A machine must be joined to act.
 */
export const TaskLeaseRef = Schema.Struct({
  tracker: IssueRef.fields.tracker,
  host: IssueRef.fields.host,
  scope: IssueRef.fields.scope,
  key: IssueRef.fields.key,
  relayOrigin: Schema.NonEmptyString,
});
export type TaskLeaseRef = typeof TaskLeaseRef.Type;

export const TaskLeaseTakeInput = Schema.Struct({
  ...TaskLeaseRef.fields,
  /** A board task ID requests one hand-off after the claim succeeds. */
  handoffTaskId: Schema.optional(Schema.NonEmptyString),
  agent: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,64}$/))),
});
export type TaskLeaseTakeInput = typeof TaskLeaseTakeInput.Type;

export const TaskLeaseReleaseInput = Schema.Struct({
  ...TaskLeaseRef.fields,
  reason: Schema.Literals(LEASE_RELEASE_REASONS),
  /** Required for `other`. One line, at most 200 characters. */
  reasonText: Schema.optional(Schema.String),
  freeToContinue: Schema.Boolean,
  /** Goal, Done and Next, or any plain note; at most 2 KB with the follow-ups. */
  note: Schema.optional(Schema.String),
  /** Issue keys of follow-up work, such as `#51`. */
  followUps: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(20))),
});
export type TaskLeaseReleaseInput = typeof TaskLeaseReleaseInput.Type;

const WsTaskLeaseCheckRpc = Rpc.make(TASK_LEASE_WS_METHODS.check, {
  payload: TaskLeaseRef,
  success: TaskLeaseStatus,
  error: LeaseRpcError,
});
const WsTaskLeaseTakeRpc = Rpc.make(TASK_LEASE_WS_METHODS.take, {
  payload: TaskLeaseTakeInput,
  success: TaskLeaseResult,
  error: LeaseRpcError,
});
const WsTaskLeaseReleaseRpc = Rpc.make(TASK_LEASE_WS_METHODS.release, {
  payload: TaskLeaseReleaseInput,
  success: TaskLeaseResult,
  error: LeaseRpcError,
});
const WsTaskLeaseFinishRpc = Rpc.make(TASK_LEASE_WS_METHODS.finish, {
  payload: TaskLeaseRef,
  success: TaskLeaseResult,
  error: LeaseRpcError,
});
const WsTaskLeaseWithdrawRpc = Rpc.make(TASK_LEASE_WS_METHODS.withdraw, {
  payload: TaskLeaseRef,
  success: TaskLeaseResult,
  error: LeaseRpcError,
});

/** Spread into `WsRpcGroup` (through the relay group). */
export const OrchestratorSelection = Schema.Union([
  Schema.Struct({ relayOrigin: Schema.NonEmptyString, action: Schema.Literals(["get", "ensure"]) }),
  Schema.Struct({
    relayOrigin: Schema.NonEmptyString,
    action: Schema.Literal("set"),
    projectId: Schema.optional(ProjectId),
    threadId: Schema.NullOr(ThreadId),
  }),
]);
export type OrchestratorSelection = typeof OrchestratorSelection.Type;

export const OrchestratorDesignations = Schema.Struct({
  main: Schema.NullOr(ThreadId),
  projects: Schema.Record(Schema.String, ThreadId),
});
export type OrchestratorDesignations = typeof OrchestratorDesignations.Type;

export const TASK_LEASE_RPCS = [
  Rpc.make(TASK_LEASE_WS_METHODS.memorySummary, {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.NullOr(
      Schema.Struct({ total: Schema.Int, proposed: Schema.Int, disputed: Schema.Int }),
    ),
    error: LeaseRpcError,
  }),
  Rpc.make(TASK_LEASE_WS_METHODS.sandboxHandoff, {
    payload: Schema.Struct({
      relayOrigin: Schema.NonEmptyString,
      taskId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
      requestId: Schema.String.check(Schema.isUUID()),
    }),
    success: Schema.Struct({ id: ThreadId, title: Schema.String }),
    error: LeaseRpcError,
  }),
  Rpc.make(TASK_LEASE_WS_METHODS.orchestrator, {
    payload: OrchestratorSelection,
    success: OrchestratorDesignations,
    error: LeaseRpcError,
  }),
  WsTaskLeaseCheckRpc,
  WsTaskLeaseTakeRpc,
  WsTaskLeaseReleaseRpc,
  WsTaskLeaseFinishRpc,
  WsTaskLeaseWithdrawRpc,
] as const;

/** Every lease call writes to the tracker on the person's behalf, or reads for that, so all need operate. */
export const TASK_LEASE_RPC_SCOPES = {
  [TASK_LEASE_WS_METHODS.memorySummary]: AuthOrchestrationOperateScope,
  [TASK_LEASE_WS_METHODS.sandboxHandoff]: AuthOrchestrationOperateScope,
  [TASK_LEASE_WS_METHODS.orchestrator]: AuthOrchestrationOperateScope,
  [TASK_LEASE_WS_METHODS.check]: AuthOrchestrationOperateScope,
  [TASK_LEASE_WS_METHODS.take]: AuthOrchestrationOperateScope,
  [TASK_LEASE_WS_METHODS.release]: AuthOrchestrationOperateScope,
  [TASK_LEASE_WS_METHODS.finish]: AuthOrchestrationOperateScope,
  [TASK_LEASE_WS_METHODS.withdraw]: AuthOrchestrationOperateScope,
} as const;

export const TASK_LEASE_RPC_AGGREGATES = {
  [TASK_LEASE_WS_METHODS.memorySummary]: "leases",
  [TASK_LEASE_WS_METHODS.sandboxHandoff]: "leases",
  [TASK_LEASE_WS_METHODS.orchestrator]: "leases",
  [TASK_LEASE_WS_METHODS.check]: "leases",
  [TASK_LEASE_WS_METHODS.take]: "leases",
  [TASK_LEASE_WS_METHODS.release]: "leases",
  [TASK_LEASE_WS_METHODS.finish]: "leases",
  [TASK_LEASE_WS_METHODS.withdraw]: "leases",
} as const;
