// Banneret Hub: take and release from the Task dialog and the Board. The server's LeaseService writes
// to the tracker; this keeps one in-memory entry per task so the dialog and the card show the same
// operation. Phases: checking, running, settled; no check starts while an operation runs, and an
// answer whose sequence number is no longer the latest is dropped.
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  TASK_LEASE_WS_METHODS,
  type IssueRef,
  type TaskLeaseReleaseInput,
  type TaskLeaseResult,
  type TaskLeaseStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { type RelayTarget, relayKey } from "./enrolmentStore";
import {
  leaseFailureMessage,
  outcomeMessage,
  outcomeTone,
  type LeaseCallFailure,
} from "./lease.logic";

const checkCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-lease:check",
  tag: TASK_LEASE_WS_METHODS.check,
});
const takeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-lease:take",
  tag: TASK_LEASE_WS_METHODS.take,
});
const releaseCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-lease:release",
  tag: TASK_LEASE_WS_METHODS.release,
});
const finishCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-lease:finish",
  tag: TASK_LEASE_WS_METHODS.finish,
});
const withdrawCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-lease:withdraw",
  tag: TASK_LEASE_WS_METHODS.withdraw,
});

export type LeaseCall<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

const failureOf = (cause: Cause.Cause<unknown>): LeaseCallFailure => {
  const error = Cause.squash(cause);
  if (typeof error !== "object" || error === null) return { tag: null, detail: null };
  const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : null;
  const detail = "detail" in error && typeof error.detail === "string" ? error.detail : null;
  return { tag, detail };
};

async function call<A>(run: Promise<AtomCommandResult<A, unknown>>): Promise<LeaseCall<A>> {
  try {
    const result = await run;
    return result._tag === "Success"
      ? { ok: true, value: result.value }
      : { ok: false, message: leaseFailureMessage(failureOf(result.cause)) };
  } catch {
    return { ok: false, message: leaseFailureMessage({ tag: null, detail: null }) };
  }
}

/**
 * Every lease call the Hub makes; tests replace them. Each names the relay whose person acts, so the
 * server checks the tracker login against that company's account.
 */
export const leaseRpc = {
  check: (
    { environmentId, relayOrigin }: RelayTarget,
    ref: IssueRef,
  ): Promise<LeaseCall<TaskLeaseStatus>> =>
    call(
      runAtomCommand(appAtomRegistry, checkCommand, {
        environmentId,
        input: { ...ref, relayOrigin },
      }),
    ),
  take: (
    { environmentId, relayOrigin }: RelayTarget,
    ref: IssueRef,
  ): Promise<LeaseCall<TaskLeaseResult>> =>
    call(
      runAtomCommand(appAtomRegistry, takeCommand, {
        environmentId,
        input: { ...ref, relayOrigin, agent: "hub" },
      }),
    ),
  release: (
    { environmentId, relayOrigin }: RelayTarget,
    input: TaskLeaseReleaseInput,
  ): Promise<LeaseCall<TaskLeaseResult>> =>
    call(
      runAtomCommand(appAtomRegistry, releaseCommand, {
        environmentId,
        input: { ...input, relayOrigin },
      }),
    ),
  finish: (
    { environmentId, relayOrigin }: RelayTarget,
    ref: IssueRef,
  ): Promise<LeaseCall<TaskLeaseResult>> =>
    call(
      runAtomCommand(appAtomRegistry, finishCommand, {
        environmentId,
        input: { ...ref, relayOrigin },
      }),
    ),
  withdraw: (
    { environmentId, relayOrigin }: RelayTarget,
    ref: IssueRef,
  ): Promise<LeaseCall<TaskLeaseResult>> =>
    call(
      runAtomCommand(appAtomRegistry, withdrawCommand, {
        environmentId,
        input: { ...ref, relayOrigin },
      }),
    ),
};

export type LeaseOperation = "take" | "release" | "finish" | "withdraw";

export interface LeaseNotice {
  readonly tone: "ok" | "warn" | "error";
  readonly message: string;
  readonly at: number;
}

export type LeasePhase =
  | { readonly kind: "checking" }
  | { readonly kind: "running"; readonly operation: LeaseOperation; readonly startedAt: number }
  | { readonly kind: "settled" };

export interface LeaseEntry {
  readonly seq: number;
  readonly phase: LeasePhase;
  /** The server's last answer for this task; null before the first one. */
  readonly status: TaskLeaseStatus | null;
  readonly notice: LeaseNotice | null;
  /** When this window last finished a take; the board shows "Taken by you" until the snapshot agrees. */
  readonly takenAt: number | null;
}

interface LeaseStoreState {
  readonly entries: Readonly<Record<string, LeaseEntry>>;
}

export const useLeaseStore = create<LeaseStoreState>(() => ({ entries: {} }));

const leaseKey = (target: RelayTarget, taskId: string) => `${relayKey(target)}\u0000${taskId}`;

const entryOf = (key: string): LeaseEntry | undefined => useLeaseStore.getState().entries[key];

const put = (key: string, entry: LeaseEntry) =>
  useLeaseStore.setState((state) => ({ entries: { ...state.entries, [key]: entry } }));

/** Applies an answer only while the call that asked is still the latest one for the task. */
const settle = (key: string, seq: number, change: (entry: LeaseEntry) => LeaseEntry) => {
  const entry = entryOf(key);
  if (entry === undefined || entry.seq !== seq) return;
  put(key, change(entry));
};

export function useLeaseEntry(target: RelayTarget, taskId: string): LeaseEntry | undefined {
  return useLeaseStore((state) => state.entries[leaseKey(target, taskId)]);
}

/**
 * Reads who holds the task now. Does nothing while an operation runs. A check that opens the task
 * clears the last notice; the check after a failed operation keeps it.
 */
export async function checkLease(
  target: RelayTarget,
  taskId: string,
  ref: IssueRef,
  options: { readonly keepNotice?: boolean } = {},
): Promise<void> {
  const key = leaseKey(target, taskId);
  const entry = entryOf(key);
  if (entry?.phase.kind === "running") return;
  const seq = (entry?.seq ?? 0) + 1;
  put(key, {
    seq,
    phase: { kind: "checking" },
    status: entry?.status ?? null,
    notice: options.keepNotice === true ? (entry?.notice ?? null) : null,
    takenAt: entry?.takenAt ?? null,
  });
  const answer = await leaseRpc.check(target, ref);
  settle(key, seq, (current) =>
    answer.ok
      ? { ...current, phase: { kind: "settled" }, status: answer.value }
      : {
          ...current,
          phase: { kind: "settled" },
          notice: { tone: "error", message: answer.message, at: Date.now() },
        },
  );
}

/** Runs one operation. A second one on the same task while it runs does nothing. */
export async function runLease(
  target: RelayTarget,
  taskId: string,
  ref: IssueRef,
  operation: LeaseOperation,
  release?: Omit<TaskLeaseReleaseInput, keyof IssueRef | "relayOrigin">,
): Promise<LeaseCall<TaskLeaseResult>> {
  const call = (kind: LeaseOperation): Promise<LeaseCall<TaskLeaseResult>> => {
    switch (kind) {
      case "take":
        return leaseRpc.take(target, ref);
      case "release":
        return release === undefined
          ? Promise.resolve({ ok: false, message: "Pick a reason to release the task." })
          : leaseRpc.release(target, { ...ref, ...release });
      case "finish":
        return leaseRpc.finish(target, ref);
      case "withdraw":
        return leaseRpc.withdraw(target, ref);
    }
  };
  const key = leaseKey(target, taskId);
  const entry = entryOf(key);
  if (entry?.phase.kind === "running") {
    return { ok: false, message: "Another change to this task is still running." };
  }
  const seq = (entry?.seq ?? 0) + 1;
  put(key, {
    seq,
    phase: { kind: "running", operation, startedAt: Date.now() },
    status: entry?.status ?? null,
    notice: null,
    takenAt: entry?.takenAt ?? null,
  });
  const answer = await call(operation);
  if (answer.ok) {
    const result = answer.value;
    const message = outcomeMessage(result);
    settle(key, seq, () => ({
      seq,
      phase: { kind: "settled" },
      status: result.status,
      notice: message === null ? null : { tone: outcomeTone(result), message, at: Date.now() },
      takenAt: result.outcome === "taken" ? Date.now() : null,
    }));
    return answer;
  }
  settle(key, seq, (current) => ({
    ...current,
    phase: { kind: "settled" },
    notice: { tone: "error", message: answer.message, at: Date.now() },
  }));
  // The tracker may have changed before the call failed; read it again rather than guess.
  await checkLease(target, taskId, ref, { keepNotice: true });
  return answer;
}

/** The task whose Release dialog is open; null when closed. */
export interface ReleaseTarget {
  /** The relay (on its environment) the task belongs to. */
  readonly relay: RelayTarget;
  readonly taskId: string;
  readonly title: string;
  readonly ref: IssueRef;
}

export const useReleaseDialogStore = create<{ readonly target: ReleaseTarget | null }>(() => ({
  target: null,
}));

export function openReleaseDialog(target: ReleaseTarget | null): void {
  useReleaseDialogStore.setState({ target });
}
