// Banneret Hub: this client's view of each environment's relay enrolments, one per relay. The server
// holds the keys and tokens and makes every relay call; `status` is a local read, so polling it never
// reaches a relay.
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  BANNERET_RELAY_WS_METHODS,
  type SandboxAction,
  type WarningPolicy,
  type OfficeEdit,
  type PoolFounderAction,
  type BanneretEnrolmentList,
  type BanneretEnrolmentMachine,
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

const resourcesCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret:resources",
  tag: BANNERET_RELAY_WS_METHODS.resources,
});
const foldersCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret:folders",
  tag: BANNERET_RELAY_WS_METHODS.folders,
});
const sandboxCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret:sandbox",
  tag: BANNERET_RELAY_WS_METHODS.sandbox,
});
const requestWorkspaceCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret:request-workspace",
  tag: BANNERET_RELAY_WS_METHODS.requestWorkspace,
});
const officeEditCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret:officeEdit",
  tag: BANNERET_RELAY_WS_METHODS.officeEdit,
});
const officeHeardCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret:officeHeard",
  tag: BANNERET_RELAY_WS_METHODS.officeHeard,
});
const founderCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret:pool-founder",
  tag: BANNERET_RELAY_WS_METHODS.poolFounder,
});
const poolCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret:pool",
  tag: BANNERET_RELAY_WS_METHODS.pool,
});
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
  if (typeof error === "string") return error;
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

/** One relay as seen from one environment: what every per-company call and store is keyed by. */
export interface RelayTarget {
  readonly environmentId: EnvironmentId;
  readonly relayOrigin: string;
}

export const relayKey = (target: RelayTarget) =>
  `${target.environmentId}\u0000${target.relayOrigin}`;

/** Every relay call a screen makes; tests replace these. */
export const enrolmentRpc = {
  resources: (environmentId: EnvironmentId, policy?: WarningPolicy) =>
    outcome(
      runAtomCommand(appAtomRegistry, resourcesCommand, {
        environmentId,
        input: policy ? { policy } : {},
      }),
    ),
  folders: (environmentId: EnvironmentId) =>
    outcome(runAtomCommand(appAtomRegistry, foldersCommand, { environmentId, input: {} })),
  sandbox: ({ environmentId, relayOrigin }: RelayTarget, action: typeof SandboxAction.Type) =>
    outcome(
      runAtomCommand(appAtomRegistry, sandboxCommand, {
        environmentId,
        input: { relayOrigin, action },
      }),
    ),
  requestWorkspace: ({ environmentId, relayOrigin }: RelayTarget, hostId: string) =>
    outcome(
      runAtomCommand(appAtomRegistry, requestWorkspaceCommand, {
        environmentId,
        input: { relayOrigin, hostId },
      }),
    ),
  officeEdit: ({ environmentId, relayOrigin }: RelayTarget, action: OfficeEdit) =>
    outcome(
      runAtomCommand(appAtomRegistry, officeEditCommand, {
        environmentId,
        input: { relayOrigin, action },
      }),
    ),
  officeHeard: ({ environmentId, relayOrigin }: RelayTarget, ids: readonly string[]) =>
    outcome(
      runAtomCommand(appAtomRegistry, officeHeardCommand, {
        environmentId,
        input: { relayOrigin, ids },
      }),
    ),
  poolFounder: ({ environmentId, relayOrigin }: RelayTarget, action?: PoolFounderAction) =>
    outcome(
      runAtomCommand(appAtomRegistry, founderCommand, {
        environmentId,
        input: { relayOrigin, action },
      }),
    ),
  pool: ({ environmentId, relayOrigin }: RelayTarget) =>
    outcome(
      runAtomCommand(appAtomRegistry, poolCommand, { environmentId, input: { relayOrigin } }),
    ),
  status: (environmentId: EnvironmentId): Promise<RelayOutcome<BanneretEnrolmentList>> =>
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
  cancel: ({
    environmentId,
    relayOrigin,
  }: RelayTarget): Promise<RelayOutcome<BanneretEnrolmentView>> =>
    outcome(
      runAtomCommand(appAtomRegistry, cancelCommand, { environmentId, input: { relayOrigin } }),
    ),
  leave: (
    { environmentId, relayOrigin }: RelayTarget,
    mode: "revoke" | "forget",
    keepWorkspace = false,
  ): Promise<RelayOutcome<BanneretEnrolmentView>> =>
    outcome(
      runAtomCommand(appAtomRegistry, leaveCommand, {
        environmentId,
        input: { relayOrigin, mode, keepWorkspace },
      }),
    ),
  machines: (
    { environmentId, relayOrigin }: RelayTarget,
    cursor?: string,
  ): Promise<RelayOutcome<BanneretRelayMachinesPage>> =>
    outcome(
      runAtomCommand(appAtomRegistry, machinesCommand, {
        environmentId,
        input: cursor === undefined ? { relayOrigin } : { relayOrigin, cursor },
      }),
    ),
  revokeMachine: (
    { environmentId, relayOrigin }: RelayTarget,
    machineId: string,
  ): Promise<RelayOutcome<unknown>> =>
    outcome(
      runAtomCommand(appAtomRegistry, revokeMachineCommand, {
        environmentId,
        input: { relayOrigin, machineId },
      }),
    ),
  matchProjects: (
    { environmentId, relayOrigin }: RelayTarget,
    remoteUrls: ReadonlyArray<string>,
  ): Promise<RelayOutcome<{ readonly matched: ReadonlyArray<string> }>> =>
    outcome(
      runAtomCommand(appAtomRegistry, matchProjectsCommand, {
        environmentId,
        input: { relayOrigin, remoteUrls },
      }),
    ),
};

interface EnrolmentState {
  readonly missingStatusRpc: Readonly<Record<EnvironmentId, boolean>>;
  /** Per environment, its enrolment with each relay it has tried, in origin order. */
  readonly views: Readonly<Record<EnvironmentId, ReadonlyArray<BanneretEnrolmentView>>>;
  /** Per environment, what it tells every relay about itself; from the last successful read. */
  readonly machines: Readonly<Record<EnvironmentId, BanneretEnrolmentMachine>>;
}

export const useEnrolmentStore = create<EnrolmentState>(() => ({
  views: {},
  machines: {},
  missingStatusRpc: {},
}));

const EMPTY_VIEWS: ReadonlyArray<BanneretEnrolmentView> = [];

/** Stores one relay's view, as a call about that relay answered it. */
export function storeEnrolmentView(environmentId: EnvironmentId, view: BanneretEnrolmentView) {
  useEnrolmentStore.setState((state) => {
    const others = (state.views[environmentId] ?? EMPTY_VIEWS).filter(
      (entry) => entry.relayOrigin !== view.relayOrigin,
    );
    const next = [...others, view].toSorted((a, b) => a.relayOrigin.localeCompare(b.relayOrigin));
    return { views: { ...state.views, [environmentId]: next } };
  });
}

/**
 * Reads the environment's enrolments. A failed read keeps the last views, so a dropped connection
 * never shows a joined machine as not joined; with nothing read yet it shows none.
 */
export async function refreshEnrolment(environmentId: EnvironmentId) {
  const result = await enrolmentRpc.status(environmentId);
  if (result.ok) {
    useEnrolmentStore.setState((state) => ({
      missingStatusRpc: { ...state.missingStatusRpc, [environmentId]: false },
      views: { ...state.views, [environmentId]: result.value.enrolments },
      machines: { ...state.machines, [environmentId]: result.value.machine },
    }));
  } else {
    useEnrolmentStore.setState((state) => ({
      missingStatusRpc: {
        ...state.missingStatusRpc,
        [environmentId]: result.message.includes(
          "Unknown request tag: " + BANNERET_RELAY_WS_METHODS.status,
        ),
      },
      views: state.views[environmentId]
        ? state.views
        : { ...state.views, [environmentId]: EMPTY_VIEWS },
    }));
  }
  return result.ok ? result.value.enrolments : null;
}

/** Every relay this environment has an enrolment with. */
export function useEnrolmentViews(
  environmentId: EnvironmentId | null,
): ReadonlyArray<BanneretEnrolmentView> {
  return useEnrolmentStore((state) =>
    environmentId === null ? EMPTY_VIEWS : (state.views[environmentId] ?? EMPTY_VIEWS),
  );
}

/** The environment's enrolment with one relay, by relay origin; null when it has none. */
export function useEnrolmentView(
  environmentId: EnvironmentId | null,
  relayOrigin: string | null | undefined,
): BanneretEnrolmentView | null {
  return useEnrolmentStore((state) =>
    environmentId === null || relayOrigin == null
      ? null
      : ((state.views[environmentId] ?? EMPTY_VIEWS).find(
          (view) => view.relayOrigin === relayOrigin,
        ) ?? null),
  );
}

/** What the environment tells relays about itself; null until its first read answers. */
export function useEnrolmentMachine(
  environmentId: EnvironmentId | null,
): BanneretEnrolmentMachine | null {
  return useEnrolmentStore((state) =>
    environmentId === null ? null : (state.machines[environmentId] ?? null),
  );
}

export function useJoinedElsewhere(environmentId: EnvironmentId | null, origin: string) {
  return useEnrolmentStore(({ views }) =>
    Object.entries(views).some(
      ([id, entries]) =>
        id !== environmentId &&
        entries.some((entry) => entry.relayOrigin === origin && entry.state === "configured"),
    ),
  );
}

/** Status is read every 2 s while the wizard is open, every 30 s otherwise. */
export const ENROLMENT_POLL_MS = { wizard: 2000, idle: 30_000 } as const;
