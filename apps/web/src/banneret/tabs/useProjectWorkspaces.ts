// Banneret Hub: the workspaces the Workspaces tabs are made of (the sidebar's project groups, over
// every project, with all "No project" groups as one), which one is shown, and what that hides in
// the sidebar.
import {
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useMessages } from "gt-react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
} from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../../state/environments";
import type { Project } from "../../types";
import { isNoProjectGroup } from "../sidebarProjectSnapshots";
import { filterProjectsForWorkspace } from "../workspaces.logic";
import { useWorkspaces, useWorkspacesStore } from "../workspacesStore";
import { useTabsStore } from "./tabsStore";
import {
  NO_PROJECT_KEY,
  openTabs,
  shownWorkspace,
  type WorkspaceIdentity,
} from "./workspaceTabs.logic";
import { useWorkspaceTabsStore } from "./workspaceTabsStore";

export interface ProjectWorkspace extends WorkspaceIdentity {
  readonly name: string;
  readonly projects: ReadonlyArray<SidebarProjectGroupMember>;
  /** Archived projects are only listed while their tab is open. */
  readonly archived: boolean;
}

export const projectKeyOf = (environmentId: string, projectId: string) =>
  `${environmentId}:${projectId}`;

const workspaceKeys = (workspace: ProjectWorkspace) =>
  new Set(workspace.projects.map((p) => projectKeyOf(p.environmentId, p.id)));

export function workspaceHasProject(
  workspace: ProjectWorkspace,
  environmentId: string,
  projectId: string,
) {
  return workspace.projects.some((p) => p.environmentId === environmentId && p.id === projectId);
}

/** The environments a workspace's projects live on, by name. */
export const environmentNames = (workspace: ProjectWorkspace) => [
  ...new Set(workspace.projects.flatMap((p) => p.environmentLabel ?? [])),
];

const NO_PROJECTS: ReadonlyArray<Project> = [];

/** `enabled` false lists nothing, so Chats mode never pays for the grouping. */
export function useProjectWorkspaces(enabled = true): ReadonlyArray<ProjectWorkspace> {
  const allProjects = useProjects();
  const projects = enabled ? allProjects : NO_PROJECTS;
  const settings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const resolve = useMessages();
  const labels = new Map(environments.map((e) => [e.environmentId, e.label] as const));
  const groups = buildSidebarProjectSnapshots(
    {
      projects,
      groupScratchProjects: true,
      settings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    },
    resolve,
  );
  const noProject = groups.filter(isNoProjectGroup);
  const workspaces: ProjectWorkspace[] = groups
    .filter((group) => !isNoProjectGroup(group))
    .map((group) => ({
      key: group.projectKey,
      name: group.displayName,
      members: group.memberProjects.map(derivePhysicalProjectKey),
      projects: group.memberProjects,
      archived: group.archived,
    }));
  if (noProject.length > 0) {
    const members = noProject.flatMap((group) => group.memberProjects);
    workspaces.push({
      key: NO_PROJECT_KEY,
      name: "No project",
      members: members.map(derivePhysicalProjectKey),
      projects: members,
      archived: false,
    });
  }
  return workspaces.toSorted((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** The projects the workspace switcher shows right now. */
function useSwitcherScope() {
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const activeId = useWorkspacesStore((state) => state.activeId);
  return filterProjectsForWorkspace(projects, workspaces, activeId);
}

export function useWorkspaceTabsView(enabled = true) {
  const state = useWorkspaceTabsStore();
  const workspaces = useProjectWorkspaces(enabled);
  const inSwitcher = new Set(useSwitcherScope().map((p) => projectKeyOf(p.environmentId, p.id)));
  const shown = shownWorkspace(state, workspaces, (workspace) =>
    workspace.projects.some((p) => inSwitcher.has(projectKeyOf(p.environmentId, p.id))),
  );
  return { state, workspaces, tabs: openTabs(state, workspaces), shown };
}

/**
 * Whether Workspaces mode is in effect: chosen, and its bar on screen. With the bar hidden, or in a
 * window too narrow for it (tabsFrame.css), the sidebar lists what it lists in Chats mode.
 */
export function useWorkspaceTabsInEffect(): boolean {
  const mode = useWorkspaceTabsStore((state) => state.mode);
  const hidden = useTabsStore((state) => state.hidden);
  const wide = useMediaQuery("md");
  return mode === "workspaces" && !hidden && wide;
}

/**
 * The `environmentId:projectId` keys of every project outside the shown workspace, or null when
 * nothing is narrowed. A project that has not loaded is in no list, so its threads stay.
 */
export function useProjectsOutsideShownWorkspace(): ReadonlySet<string> | null {
  const inEffect = useWorkspaceTabsInEffect();
  const projects: ReadonlyArray<Project> = useProjects();
  const { shown } = useWorkspaceTabsView(inEffect);
  if (!inEffect || shown === null) return null;
  const inside = workspaceKeys(shown);
  return new Set(
    projects.map((p) => projectKeyOf(p.environmentId, p.id)).filter((key) => !inside.has(key)),
  );
}
