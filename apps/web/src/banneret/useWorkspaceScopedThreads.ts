// Banneret Hub: the threads the sidebar lists. A workspace shows only its own projects' threads (and
// scratch threads, which every one shows); with Workspaces tabs the shown tab narrows that again.
import { useProjects } from "../state/entities";
import { projectKeyOf, useProjectsOutsideShownWorkspace } from "./tabs/useProjectWorkspaces";
import { filterThreadsForWorkspace, workspaceScopeProjectKeys } from "./workspaces.logic";
import { useWorkspaces, useWorkspacesStore } from "./workspacesStore";

/** The threads of the workspace switcher's choice. The command palette searches these. */
export function useWorkspaceThreads<
  TThread extends Parameters<typeof filterThreadsForWorkspace>[0][number],
>(threads: ReadonlyArray<TThread>): ReadonlyArray<TThread> {
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const activeId = useWorkspacesStore((state) => state.activeId);
  return filterThreadsForWorkspace(threads, projects, workspaces, activeId);
}

export function useWorkspaceScopedThreads<
  TThread extends Parameters<typeof filterThreadsForWorkspace>[0][number],
>(threads: ReadonlyArray<TThread>): ReadonlyArray<TThread> {
  const scoped = useWorkspaceThreads(threads);
  const outside = useProjectsOutsideShownWorkspace();
  if (outside === null) return scoped;
  return scoped.filter(
    (thread) => !outside.has(projectKeyOf(thread.environmentId, thread.projectId)),
  );
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
  const outside = useProjectsOutsideShownWorkspace();
  const keys = workspaceScopeProjectKeys(scopedProjectKeys, projects, workspaces, activeId);
  if (outside === null || scopedProjectKeys !== null) return keys;
  const all = keys ?? new Set(projects.map((p) => projectKeyOf(p.environmentId, p.id)));
  return new Set([...all].filter((key) => !outside.has(key)));
}
