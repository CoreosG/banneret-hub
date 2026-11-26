// Banneret Hub: the project picker a workspace and the Enterprise wizard share. Projects are listed
// once per repository across every connected environment, the key a workspace stores.
import type { BanneretWorkspace } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { useProjects } from "../state/entities";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import {
  assignProjects,
  projectIdentityKeys,
  workspaceIdForProject,
  workspaceProjectKey,
} from "./workspaces.logic";
import { openWorkspaceDialog } from "./workspacesStore";

// Keyed by repository, whatever the sidebar's grouping, so one row is exactly what a workspace stores.
const REPOSITORY_GROUPING = {
  sidebarProjectGroupingMode: "repository",
  sidebarProjectGroupingOverrides: {},
} as const;

export function usePickableProjectGroups(): SidebarProjectSnapshot[] {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environments = useEnvironmentIdentities();
  const resolve = useMessages();
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label] as const));
  return buildSidebarProjectSnapshots(
    {
      projects,
      groupScratchProjects: true,
      settings: REPOSITORY_GROUPING,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    },
    resolve,
  )
    .filter((group) => !group.isScratch)
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

const groupKeys = (group: SidebarProjectSnapshot) => [
  ...new Set(group.memberProjects.map(workspaceProjectKey)),
];

/**
 * The workspace with exactly the picked projects; other workspaces give them up. Keys of projects
 * on environments that are not connected now stay as they were. Every key a listed project matches
 * by counts as known, so an old path key is dropped when it is unchecked.
 */
export function workspaceWithProjects(input: {
  readonly workspaces: ReadonlyArray<BanneretWorkspace>;
  readonly workspace: BanneretWorkspace;
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly selection: ReadonlySet<string>;
  readonly now: string;
}): BanneretWorkspace[] {
  const identityKeys = (group: SidebarProjectSnapshot) =>
    group.memberProjects.flatMap(projectIdentityKeys);
  const known = new Set(input.groups.flatMap(identityKeys));
  const kept = input.workspace.projectKeys.filter((key) => !known.has(key));
  const pickedGroups = input.groups.filter((group) => input.selection.has(group.projectKey));
  const picked = pickedGroups.flatMap((group) => groupKeys(group));
  return assignProjects({
    workspaces: input.workspaces,
    workspace: input.workspace,
    projectKeys: [...kept, ...picked],
    claimedKeys: pickedGroups.flatMap(identityKeys),
    now: input.now,
  });
}

export function ownerOfGroup(
  group: SidebarProjectSnapshot,
  workspaces: ReadonlyArray<BanneretWorkspace>,
): string | null {
  return (
    group.memberProjects
      .map((member) => workspaceIdForProject(member, workspaces))
      .find((owner) => owner !== null) ?? null
  );
}

/** One row per repository; a row another workspace owns says it moves. */
export function ProjectChecklist(props: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly workspaces: ReadonlyArray<BanneretWorkspace>;
  readonly editingId: string | null;
  readonly selection: ReadonlySet<string>;
  readonly onToggle: (projectKey: string, checked: boolean) => void;
}) {
  if (props.groups.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No projects on your connected environments yet.
      </p>
    );
  }
  return (
    <div className="max-h-72 overflow-y-auto rounded-md border">
      {props.groups.map((group) => {
        const owner = ownerOfGroup(group, props.workspaces);
        const ownerName =
          owner !== null && owner !== props.editingId
            ? props.workspaces.find((workspace) => workspace.id === owner)?.name
            : undefined;
        return (
          <label
            key={group.projectKey}
            className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm not-last:border-b"
          >
            <Checkbox
              checked={props.selection.has(group.projectKey)}
              onCheckedChange={(checked) => props.onToggle(group.projectKey, checked)}
            />
            <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
            {ownerName !== undefined ? (
              <span className="shrink-0 text-muted-foreground text-xs">Moves from {ownerName}</span>
            ) : group.remoteEnvironmentLabels.length > 0 ? (
              <span className="shrink-0 truncate text-muted-foreground text-xs">
                {group.remoteEnvironmentLabels.join(", ")}
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

/** Solo is plain T3 Code; Enterprise joins this machine to a company relay. */
export function WorkspaceKindChoice(props: { readonly kind: "solo" | "enterprise" }) {
  return (
    <div className="flex gap-1.5" role="group" aria-label="Workspace type">
      <Button
        size="xs"
        type="button"
        variant={props.kind === "solo" ? "secondary" : "ghost"}
        aria-pressed={props.kind === "solo"}
        onClick={() => openWorkspaceDialog({ kind: "create" })}
      >
        Solo
      </Button>
      <Button
        size="xs"
        type="button"
        variant={props.kind === "enterprise" ? "secondary" : "ghost"}
        aria-pressed={props.kind === "enterprise"}
        onClick={() => openWorkspaceDialog({ kind: "enterprise" })}
      >
        Enterprise
      </Button>
    </div>
  );
}
