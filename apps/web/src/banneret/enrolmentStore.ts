// Banneret Hub: this client's view of each environment's relay enrolment. The server holds the key
// and token and makes every relay call; `status` is a local read, so polling it never reaches a relay.
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  BANNERET_RELAY_WS_METHODS,
  type BanneretEnrolmentView,
  type BanneretMachineKind,
  type BanneretRelayMachinesPage,
  type BanneretRelayProbeResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const statusCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:status",
  tag: BANNERET_RELAY_WS_METHODS.status,
});
const probeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:probe",
  tag: BANNERET_RELAY_WS_METHODS.probe,
});
const startCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:start",
  tag: BANNERET_RELAY_WS_METHODS.start,
});
const cancelCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:cancel",
  tag: BANNERET_RELAY_WS_METHODS.cancel,
});
const leaveCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:leave",
  tag: BANNERET_RELAY_WS_METHODS.leave,
});
const machinesCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:machines",
  tag: BANNERET_RELAY_WS_METHODS.machines,
});
const revokeMachineCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:revoke-machine",
  tag: BANNERET_RELAY_WS_METHODS.revokeMachine,
});
const matchProjectsCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:match-projects",
  tag: BANNERET_RELAY_WS_METHODS.matchProjects,
});

export type RelayOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const messageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "This environment could not do that.";
};

async function outcome<T>(run: Promise<AtomCommandResult<T, unknown>>): Promise<RelayOutcome<T>> {
  try {
    const result = await run;
    return result._tag === "Success"
      ? { ok: true, value: result.value }
      : { ok: false, message: messageOf(result.cause) };
  } catch {
    return { ok: false, message: "This environment could not be reached." };
  }
}

/** Every relay call a screen makes; tests replace these. */
export const enrolmentRpc = {
  status: (environmentId: EnvironmentId): Promise<RelayOutcome<BanneretEnrolmentView>> =>
    outcome(runAtomCommand(appAtomRegistry, statusCommand, { environmentId, input: {} })),
  probe: (
    environmentId: EnvironmentId,
    origin: string,
  ): Promise<RelayOutcome<BanneretRelayProbeResult>> =>
    outcome(runAtomCommand(appAtomRegistry, probeCommand, { environmentId, input: { origin } })),
  start: (
    environmentId: EnvironmentId,
    input: { readonly origin: string; readonly label: string; readonly kind: BanneretMachineKind },
  ): Promise<RelayOutcome<BanneretEnrolmentView>> =>
    outcome(runAtomCommand(appAtomRegistry, startCommand, { environmentId, input })),
  cancel: (environmentId: EnvironmentId): Promise<RelayOutcome<BanneretEnrolmentView>> =>
    outcome(runAtomCommand(appAtomRegistry, cancelCommand, { environmentId, input: {} })),
  leave: (
    environmentId: EnvironmentId,
    mode: "revoke" | "forget",
  ): Promise<RelayOutcome<BanneretEnrolmentView>> =>
    outcome(runAtomCommand(appAtomRegistry, leaveCommand, { environmentId, input: { mode } })),
  machines: (
    environmentId: EnvironmentId,
    cursor?: string,
  ): Promise<RelayOutcome<BanneretRelayMachinesPage>> =>
    outcome(
      runAtomCommand(appAtomRegistry, machinesCommand, {
        environmentId,
        input: cursor === undefined ? {} : { cursor },
      }),
    ),
  revokeMachine: (
    environmentId: EnvironmentId,
    machineId: string,
  ): Promise<RelayOutcome<unknown>> =>
    outcome(
      runAtomCommand(appAtomRegistry, revokeMachineCommand, {
        environmentId,
        input: { machineId },
      }),
    ),
  matchProjects: (
    environmentId: EnvironmentId,
    remoteUrls: ReadonlyArray<string>,
  ): Promise<RelayOutcome<{ readonly matched: ReadonlyArray<string> }>> =>
    outcome(
      runAtomCommand(appAtomRegistry, matchProjectsCommand, {
        environmentId,
        input: { remoteUrls },
      }),
    ),
};

interface EnrolmentState {
  readonly views: Readonly<Record<EnvironmentId, BanneretEnrolmentView>>;
}

export const useEnrolmentStore = create<EnrolmentState>(() => ({ views: {} }));

export function storeEnrolmentView(environmentId: EnvironmentId, view: BanneretEnrolmentView) {
  useEnrolmentStore.setState((state) => ({ views: { ...state.views, [environmentId]: view } }));
}

/**
 * Reads the environment's enrolment. A failed read keeps the last view, so a dropped connection
 * never shows a joined machine as not joined; with nothing read yet it shows as not joined.
 */
export async function refreshEnrolment(environmentId: EnvironmentId) {
  const result = await enrolmentRpc.status(environmentId);
  if (result.ok) storeEnrolmentView(environmentId, result.value);
  else if (useEnrolmentStore.getState().views[environmentId] === undefined) {
    storeEnrolmentView(environmentId, { state: "none" });
  }
  return result.ok ? result.value : null;
}

export function useEnrolmentView(
  environmentId: EnvironmentId | null,
): BanneretEnrolmentView | null {
  return useEnrolmentStore((state) =>
    environmentId === null ? null : (state.views[environmentId] ?? null),
  );
}

/** Status is read every 2 s while the wizard is open, every 30 s otherwise. */
export const ENROLMENT_POLL_MS = { wizard: 2000, idle: 30_000 } as const;
