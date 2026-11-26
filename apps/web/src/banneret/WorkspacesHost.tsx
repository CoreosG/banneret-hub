// Banneret Hub: keeps workspaces loaded from every connected environment, switches to the workspace
// of a thread or draft opened from elsewhere, and hosts the workspace dialog.
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useConnectedEnvironmentIds } from "../state/environments";
import { useRouteProject } from "./useRouteProject";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { autoSwitchTarget } from "./workspaces.logic";
import {
  loadEnvironmentWorkspaces,
  setActiveWorkspace,
  useWorkspaces,
  useWorkspacesLoaded,
  useWorkspacesStore,
} from "./workspacesStore";

function useWorkspaceSync() {
  const connected = useConnectedEnvironmentIds();
  const loaded = useRef(new Set<EnvironmentId>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads each environment's server copy as it connects
  useEffect(() => {
    for (const environmentId of loaded.current) {
      // A reconnect reads the copy again; it may have changed meanwhile.
      if (!connected.includes(environmentId)) loaded.current.delete(environmentId);
    }
    for (const environmentId of connected) {
      if (loaded.current.has(environmentId)) continue;
      loaded.current.add(environmentId);
      void loadEnvironmentWorkspaces(environmentId);
    }
  }, [connected]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- another client may have changed workspaces while this window was in the background
  useEffect(() => {
    const refresh = () => {
      for (const environmentId of loaded.current) void loadEnvironmentWorkspaces(environmentId);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
}

/**
 * Opening a thread or a draft (palette, sidebar, link, notification) shows its workspace. It decides
 * once per routed thread, after the thread, its project and that environment's workspaces have
 * loaded, so a manual switch while the thread stays open is left alone.
 */
function useWorkspaceAutoSwitch() {
  const routed = useRouteProject();
  const routeKey = routed?.key ?? null;
  const project = routed?.project ?? null;
  const workspacesLoaded = useWorkspacesLoaded(project?.environmentId ?? null);
  const workspaces = useWorkspaces();
  const activeId = useWorkspacesStore((state) => state.activeId);
  const decided = useRef<string | null>(null);
  const decision =
    project === null || !workspacesLoaded
      ? undefined
      : autoSwitchTarget({ project, workspaces, activeId });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the router: a newly opened thread or draft selects its workspace once
  useEffect(() => {
    if (routeKey === null) {
      decided.current = null;
      return;
    }
    if (decided.current === routeKey || decision === undefined) return;
    decided.current = routeKey;
    if (decision !== null) setActiveWorkspace(decision.switchTo);
  }, [routeKey, decision]);
}

export function WorkspacesHost() {
  useWorkspaceSync();
  useWorkspaceAutoSwitch();
  return <WorkspaceDialog />;
}
