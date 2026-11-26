// Banneret Hub: the threads the active workspace lists. The sidebar reads its threads through this,
// so a workspace shows only its own projects' threads (and scratch threads, which every one shows).
import { useProjects } from "../state/entities";
import { filterThreadsForWorkspace, workspaceScopeProjectKeys } from "./workspaces.logic";
import { useWorkspaces, useWorkspacesStore } from "./workspacesStore";

export function useWorkspaceScopedThreads<
  TThread extends Parameters<typeof filterThreadsForWorkspace>[0][number],
>(threads: ReadonlyArray<TThread>): ReadonlyArray<TThread> {
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const activeId = useWorkspacesStore((state) => state.activeId);
  return filterThreadsForWorkspace(threads, projects, workspaces, activeId);
}

/**
 * The sidebar's project scope with "All projects" narrowed to the workspace, for the older settled
 * threads the server counts and pages, which the thread filter above cannot reach.
 */
export function useWorkspaceScopeProjectKeys(
  scopedProjectKeys: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const activeId = useWorkspacesStore((state) => state.activeId);
  return workspaceScopeProjectKeys(scopedProjectKeys, projects, workspaces, activeId);
}
