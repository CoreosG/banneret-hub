// Banneret Hub: workspaces state. Each environment keeps a copy on its server; this client merges
// the copies (newest `updatedAt` wins per workspace), writes every change to each environment, and
// brings an environment that is behind up to date when it loads. The active workspace is this
// device's own choice, so it lives in local storage.
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  BANNERET_WORKSPACES_WS_METHODS,
  mergeBanneretWorkspaces,
  type BanneretWorkspace,
  type EnvironmentId,
} from "@t3tools/contracts";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  resolveWorkspaces,
  staleOnEnvironment,
  type ActiveWorkspaceId,
  type EnvironmentWorkspaces,
} from "./workspaces.logic";

const listCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-workspaces:list",
  tag: BANNERET_WORKSPACES_WS_METHODS.list,
});

const putCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-workspaces:put",
  tag: BANNERET_WORKSPACES_WS_METHODS.put,
});

// An environment that never answers must not hold the switcher up.
const RPC_TIMEOUT_MS = 10_000;

async function settle<T>(run: Promise<{ _tag: string; value?: T }>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), RPC_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([run.catch(() => null), timeout]);
    return result !== null && result._tag === "Success" ? (result.value as T) : null;
  } finally {
    clearTimeout(timer);
  }
}

export const workspacesRpc = {
  /** null when the environment cannot answer. */
  list: (environmentId: EnvironmentId) =>
    settle<{ readonly workspaces: ReadonlyArray<BanneretWorkspace> }>(
      runAtomCommand(appAtomRegistry, listCommand, { environmentId, input: {} }),
    ),
  put: (environmentId: EnvironmentId, workspaces: ReadonlyArray<BanneretWorkspace>) =>
    settle<{ readonly workspaces: ReadonlyArray<BanneretWorkspace> }>(
      runAtomCommand(appAtomRegistry, putCommand, { environmentId, input: { workspaces } }),
    ),
};

const ACTIVE_KEY = "banneret:active-workspace";

function readActive(): ActiveWorkspaceId {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export type WorkspaceDialogState =
  | { readonly kind: "create" }
  | { readonly kind: "manage"; readonly workspaceId: string | null }
  /** The Enterprise setup wizard, optionally for a relay already known (Join again). */
  | { readonly kind: "enterprise"; readonly origin?: string }
  /** The Machines list and Leave act on one Enterprise workspace's relay. */
  | { readonly kind: "machines"; readonly origin: string }
  | { readonly kind: "leave"; readonly origin: string }
  | null;

interface WorkspacesState {
  /** Each environment's last known copy; empty until it first answers. */
  readonly byEnvironment: EnvironmentWorkspaces;
  /** This client's own writes, merged in until every environment has them. */
  readonly local: ReadonlyArray<BanneretWorkspace>;
  readonly activeId: ActiveWorkspaceId;
  readonly dialog: WorkspaceDialogState;
}

export const useWorkspacesStore = create<WorkspacesState>(() => ({
  byEnvironment: {},
  local: [],
  activeId: readActive(),
  dialog: null,
}));

export function setActiveWorkspace(activeId: ActiveWorkspaceId) {
  useWorkspacesStore.setState({ activeId });
  try {
    if (activeId === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, activeId);
  } catch {
    // Private windows keep working, just without remembering.
  }
}

export function openWorkspaceDialog(dialog: WorkspaceDialogState) {
  useWorkspacesStore.setState({ dialog });
}

function allCopies(state: WorkspacesState) {
  return [state.local, ...Object.values(state.byEnvironment)];
}

/** The live workspaces, merged across environments. */
export function useWorkspaces(): BanneretWorkspace[] {
  const byEnvironment = useWorkspacesStore((state) => state.byEnvironment);
  const local = useWorkspacesStore((state) => state.local);
  return resolveWorkspaces(local, ...Object.values(byEnvironment));
}

/** Whether the workspaces of this environment are known (answered, or known not to). */
export function useWorkspacesLoaded(environmentId: EnvironmentId | null): boolean {
  return useWorkspacesStore((state) =>
    environmentId === null ? false : Object.hasOwn(state.byEnvironment, environmentId),
  );
}

function storeEnvironmentCopy(
  environmentId: EnvironmentId,
  workspaces: ReadonlyArray<BanneretWorkspace>,
) {
  useWorkspacesStore.setState((state) => ({
    byEnvironment: { ...state.byEnvironment, [environmentId]: workspaces },
  }));
}

/** Reads one environment's copy, then sends it whatever it is missing. */
export async function loadEnvironmentWorkspaces(environmentId: EnvironmentId) {
  const listed = await workspacesRpc.list(environmentId);
  if (listed === null) {
    if (!Object.hasOwn(useWorkspacesStore.getState().byEnvironment, environmentId)) {
      storeEnvironmentCopy(environmentId, []);
    }
    return;
  }
  storeEnvironmentCopy(environmentId, listed.workspaces);
  const merged = mergeBanneretWorkspaces(...allCopies(useWorkspacesStore.getState()));
  const stale = staleOnEnvironment(merged, listed.workspaces);
  if (stale.length === 0) return;
  const stored = await workspacesRpc.put(environmentId, stale);
  if (stored !== null) storeEnvironmentCopy(environmentId, stored.workspaces);
}

/** Records changed workspaces here at once, then on every known environment. */
export async function saveWorkspaces(changed: ReadonlyArray<BanneretWorkspace>) {
  useWorkspacesStore.setState((state) => ({
    local: mergeBanneretWorkspaces(state.local, changed),
  }));
  const targets = Object.keys(useWorkspacesStore.getState().byEnvironment) as EnvironmentId[];
  await Promise.all(
    targets.map(async (environmentId) => {
      const stored = await workspacesRpc.put(environmentId, changed);
      if (stored !== null) storeEnvironmentCopy(environmentId, stored.workspaces);
    }),
  );
}
