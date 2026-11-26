// Banneret Hub: workspaces as a scope over the sidebar's projects. "Personal" is implicit: it holds
// every project no other workspace claims, so a person without workspaces sees upstream's sidebar.
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  mergeBanneretWorkspaces,
  repositoryGroupingKeyOf,
  type BanneretWorkspace,
  type EnvironmentId,
} from "@t3tools/contracts";

import type { Project } from "../types";

/** The id the active-workspace preference uses for the implicit Personal workspace. */
const PERSONAL_WORKSPACE_ID = null;
export type ActiveWorkspaceId = string | typeof PERSONAL_WORKSPACE_ID;

type ProjectIdentity = Pick<Project, "environmentId" | "workspaceRoot" | "repositoryIdentity">;

/**
 * The key a workspace stores for a project: its repository, so every checkout of it on every
 * environment (and any later sub-folder project) follows; a folder without a repository by path.
 */
export function workspaceProjectKey(project: ProjectIdentity): string {
  return project.repositoryIdentity
    ? `repo:${repositoryGroupingKeyOf(project.repositoryIdentity)}`
    : `path:${derivePhysicalProjectKey(project)}`;
}

/** Both keys match, so a project whose repository identity arrives late still finds its workspace. */
export function projectIdentityKeys(project: ProjectIdentity): string[] {
  const path = `path:${derivePhysicalProjectKey(project)}`;
  return project.repositoryIdentity ? [workspaceProjectKey(project), path] : [path];
}

const newestFirst = (a: BanneretWorkspace, b: BanneretWorkspace) =>
  a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt > b.updatedAt ? -1 : 1;

/**
 * The live workspaces from every environment's copy plus this client's own writes. A project
 * claimed by two workspaces (environments that disagreed) stays with the newest one.
 */
export function resolveWorkspaces(
  ...lists: ReadonlyArray<ReadonlyArray<BanneretWorkspace>>
): BanneretWorkspace[] {
  const live = mergeBanneretWorkspaces(...lists)
    .filter((workspace) => !workspace.deleted)
    .toSorted(newestFirst);
  const claimed = new Set<string>();
  const resolved = live.map((workspace) => {
    const projectKeys = workspace.projectKeys.filter((key) => !claimed.has(key));
    for (const key of projectKeys) claimed.add(key);
    return projectKeys.length === workspace.projectKeys.length
      ? workspace
      : { ...workspace, projectKeys };
  });
  return resolved.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The workspace a project belongs to; null is Personal. */
export function workspaceIdForProject(
  project: ProjectIdentity,
  workspaces: ReadonlyArray<BanneretWorkspace>,
): ActiveWorkspaceId {
  const keys = projectIdentityKeys(project);
  return (
    workspaces.find((workspace) => keys.some((key) => workspace.projectKeys.includes(key)))?.id ??
    PERSONAL_WORKSPACE_ID
  );
}

/** An active id that no longer names a live workspace falls back to Personal. */
export function effectiveWorkspaceId(
  activeId: ActiveWorkspaceId,
  workspaces: ReadonlyArray<BanneretWorkspace>,
): ActiveWorkspaceId {
  return workspaces.some((workspace) => workspace.id === activeId) ? activeId : null;
}

/** The projects the active workspace shows. Scratch threads have no project, so every workspace shows them. */
export function filterProjectsForWorkspace<TProject extends Project>(
  projects: ReadonlyArray<TProject>,
  workspaces: ReadonlyArray<BanneretWorkspace>,
  activeId: ActiveWorkspaceId,
): ReadonlyArray<TProject> {
  if (workspaces.length === 0) return projects;
  const active = effectiveWorkspaceId(activeId, workspaces);
  return projects.filter(
    (project) => project.isScratch || workspaceIdForProject(project, workspaces) === active,
  );
}

/**
 * The threads the active workspace lists: those of its projects and scratch threads. A thread whose
 * project has not loaded yet stays, so a new thread never flickers out of the list.
 */
export function filterThreadsForWorkspace<
  TThread extends { readonly environmentId: EnvironmentId; readonly projectId: string },
>(
  threads: ReadonlyArray<TThread>,
  projects: ReadonlyArray<Project>,
  workspaces: ReadonlyArray<BanneretWorkspace>,
  activeId: ActiveWorkspaceId,
): ReadonlyArray<TThread> {
  if (workspaces.length === 0) return threads;
  const active = effectiveWorkspaceId(activeId, workspaces);
  const hidden = new Set(
    projects
      .filter(
        (project) => !project.isScratch && workspaceIdForProject(project, workspaces) !== active,
      )
      .map((project) => `${project.environmentId}:${project.id}`),
  );
  if (hidden.size === 0) return threads;
  return threads.filter((thread) => !hidden.has(`${thread.environmentId}:${thread.projectId}`));
}

/**
 * The `environmentId:projectId` keys a sidebar scope covers. Upstream's "All projects" (null) means
 * every project; with workspaces it means the active workspace's projects.
 */
export function workspaceScopeProjectKeys(
  scopedProjectKeys: ReadonlySet<string> | null,
  projects: ReadonlyArray<Project>,
  workspaces: ReadonlyArray<BanneretWorkspace>,
  activeId: ActiveWorkspaceId,
): ReadonlySet<string> | null {
  if (scopedProjectKeys !== null || workspaces.length === 0) return scopedProjectKeys;
  return new Set(
    filterProjectsForWorkspace(projects, workspaces, activeId).map(
      (project) => `${project.environmentId}:${project.id}`,
    ),
  );
}

/**
 * Sets one workspace's projects and takes those projects out of any other workspace, so a project
 * belongs to at most one. Returns only the records that changed, stamped `now`.
 */
export function assignProjects(input: {
  readonly workspaces: ReadonlyArray<BanneretWorkspace>;
  readonly workspace: BanneretWorkspace;
  readonly projectKeys: ReadonlyArray<string>;
  /** Every key the picked projects match by (see projectIdentityKeys); defaults to projectKeys. */
  readonly claimedKeys?: ReadonlyArray<string>;
  readonly now: string;
}): BanneretWorkspace[] {
  const keys = [...new Set(input.projectKeys)];
  const claimed = new Set([...keys, ...(input.claimedKeys ?? [])]);
  const others = input.workspaces.flatMap((other) => {
    if (other.id === input.workspace.id) return [];
    const remaining = other.projectKeys.filter((key) => !claimed.has(key));
    return remaining.length === other.projectKeys.length
      ? []
      : [{ ...other, projectKeys: remaining, updatedAt: input.now }];
  });
  return [{ ...input.workspace, projectKeys: keys, updatedAt: input.now }, ...others];
}

/** Deleting leaves a tombstone; its projects go back to Personal. */
export function deleteWorkspace(workspace: BanneretWorkspace, now: string): BanneretWorkspace {
  return { ...workspace, projectKeys: [], deleted: true, updatedAt: now };
}

/**
 * Where opening a thread or draft takes the switcher: the workspace of its project, or no switch
 * for a scratch thread (every workspace shows those).
 */
export function autoSwitchTarget(input: {
  readonly project: Project;
  readonly workspaces: ReadonlyArray<BanneretWorkspace>;
  readonly activeId: ActiveWorkspaceId;
}): { readonly switchTo: ActiveWorkspaceId } | null {
  if (input.project.isScratch) return null;
  const target = workspaceIdForProject(input.project, input.workspaces);
  return target === effectiveWorkspaceId(input.activeId, input.workspaces)
    ? null
    : { switchTo: target };
}

/** The records an environment lacks or holds older copies of, to bring it up to date. */
export function staleOnEnvironment(
  merged: ReadonlyArray<BanneretWorkspace>,
  environmentCopy: ReadonlyArray<BanneretWorkspace>,
): BanneretWorkspace[] {
  const held = new Map(environmentCopy.map((workspace) => [workspace.id, workspace.updatedAt]));
  return merged.filter((workspace) => {
    const updatedAt = held.get(workspace.id);
    return updatedAt === undefined || updatedAt < workspace.updatedAt;
  });
}

export type EnvironmentWorkspaces = Readonly<
  Record<EnvironmentId, ReadonlyArray<BanneretWorkspace>>
>;
