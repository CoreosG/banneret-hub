// Banneret Hub: the projects the active workspace shows. useSidebarProjectGroups reads its projects
// through this, so the sidebar, its scope menu and the pull request page follow the workspace.
import type { Project } from "../types";
import { filterProjectsForWorkspace } from "./workspaces.logic";
import { useWorkspaces, useWorkspacesStore } from "./workspacesStore";

export function useWorkspaceScopedProjects<TProject extends Project>(
  projects: ReadonlyArray<TProject>,
): ReadonlyArray<TProject> {
  const workspaces = useWorkspaces();
  const activeId = useWorkspacesStore((state) => state.activeId);
  return filterProjectsForWorkspace(projects, workspaces, activeId);
}
