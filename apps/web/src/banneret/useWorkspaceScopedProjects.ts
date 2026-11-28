// Banneret Hub: the projects the active workspace shows. useSidebarProjectGroups reads its projects
// through this, so the sidebar, its scope menu and the pull request page follow the workspace, and,
// with Workspaces tabs, the shown tab.
import type { Project } from "../types";
import { projectKeyOf, useProjectsOutsideShownWorkspace } from "./tabs/useProjectWorkspaces";
import { filterProjectsForWorkspace } from "./workspaces.logic";
import { useWorkspaces, useWorkspacesStore } from "./workspacesStore";

export function useWorkspaceScopedProjects<TProject extends Project>(
  projects: ReadonlyArray<TProject>,
): ReadonlyArray<TProject> {
  const workspaces = useWorkspaces();
  const activeId = useWorkspacesStore((state) => state.activeId);
  const outside = useProjectsOutsideShownWorkspace();
  const scoped = filterProjectsForWorkspace(projects, workspaces, activeId);
  if (outside === null) return scoped;
  return scoped.filter((project) => !outside.has(projectKeyOf(project.environmentId, project.id)));
}
