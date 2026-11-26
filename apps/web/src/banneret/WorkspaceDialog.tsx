// Banneret Hub: create, rename, delete a workspace and choose its projects. Projects are listed once
// per repository across every connected environment, the key a workspace stores.
import type { BanneretWorkspace } from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { useId, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { useProjects } from "../state/entities";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import {
  assignProjects,
  deleteWorkspace,
  projectIdentityKeys,
  workspaceIdForProject,
  workspaceProjectKey,
} from "./workspaces.logic";
import {
  openWorkspaceDialog,
  saveWorkspaces,
  setActiveWorkspace,
  useWorkspaces,
  useWorkspacesStore,
  type WorkspaceDialogState,
} from "./workspacesStore";

const MAX_NAME_LENGTH = 60;
// Keyed by repository, whatever the sidebar's grouping, so one row is exactly what a workspace stores.
const REPOSITORY_GROUPING = {
  sidebarProjectGroupingMode: "repository",
  sidebarProjectGroupingOverrides: {},
} as const;

function usePickableProjectGroups(): SidebarProjectSnapshot[] {
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

function WorkspaceEditor(props: {
  readonly dialog: Exclude<WorkspaceDialogState, null>;
  readonly onClose: () => void;
}) {
  const id = useId();
  const workspaces = useWorkspaces();
  const groups = usePickableProjectGroups();
  const [selectedId, setSelectedId] = useState<string | null>(
    props.dialog.kind === "manage" ? (props.dialog.workspaceId ?? workspaces[0]?.id ?? null) : null,
  );
  const editing =
    props.dialog.kind === "manage"
      ? (workspaces.find((workspace) => workspace.id === selectedId) ?? null)
      : null;
  const ownerOf = (group: SidebarProjectSnapshot) =>
    group.memberProjects
      .map((member) => workspaceIdForProject(member, workspaces))
      .find((owner) => owner !== null) ?? null;
  const initialSelection = (workspace: BanneretWorkspace | null) =>
    new Set(
      workspace === null
        ? []
        : groups
            .filter((group) => ownerOf(group) === workspace.id)
            .map((group) => group.projectKey),
    );
  const [name, setName] = useState(editing?.name ?? "");
  const [selection, setSelection] = useState(() => initialSelection(editing));
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const selectWorkspace = (workspace: BanneretWorkspace) => {
    setSelectedId(workspace.id);
    setName(workspace.name);
    setSelection(initialSelection(workspace));
    setConfirmingDelete(false);
  };

  if (props.dialog.kind === "manage" && editing === null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Manage workspaces</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p className="text-muted-foreground text-sm">
            You have no workspaces yet. Every project is in Personal.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
          <Button onClick={() => openWorkspaceDialog({ kind: "create" })}>New workspace…</Button>
        </DialogFooter>
      </>
    );
  }

  const trimmedName = name.trim();
  const save = () => {
    if (trimmedName.length === 0) return;
    const now = new Date().toISOString();
    const workspace: BanneretWorkspace = editing ?? {
      id: randomUUID(),
      name: trimmedName,
      kind: "solo",
      projectKeys: [],
      updatedAt: now,
    };
    // Keys of projects on environments that are not connected now stay as they were. Every key a
    // listed project matches by counts as known, so an old path key is dropped when it is unchecked.
    const identityKeys = (group: SidebarProjectSnapshot) =>
      group.memberProjects.flatMap(projectIdentityKeys);
    const known = new Set(groups.flatMap(identityKeys));
    const kept = workspace.projectKeys.filter((key) => !known.has(key));
    const pickedGroups = groups.filter((group) => selection.has(group.projectKey));
    const picked = pickedGroups.flatMap((group) => groupKeys(group));
    void saveWorkspaces(
      assignProjects({
        workspaces,
        workspace: { ...workspace, name: trimmedName },
        projectKeys: [...kept, ...picked],
        claimedKeys: pickedGroups.flatMap(identityKeys),
        now,
      }),
    );
    if (editing === null) setActiveWorkspace(workspace.id);
    props.onClose();
  };
  const remove = () => {
    if (editing === null) return;
    void saveWorkspaces([deleteWorkspace(editing, new Date().toISOString())]);
    if (useWorkspacesStore.getState().activeId === editing.id) setActiveWorkspace(null);
    props.onClose();
  };

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{editing === null ? "New workspace" : "Manage workspaces"}</DialogTitle>
        <DialogDescription>
          A workspace shows only its projects in the sidebar. Projects you leave out stay in
          Personal.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {editing !== null && workspaces.length > 1 ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Workspaces">
              {workspaces.map((workspace) => (
                <Button
                  key={workspace.id}
                  size="xs"
                  type="button"
                  variant={workspace.id === editing.id ? "secondary" : "ghost"}
                  aria-pressed={workspace.id === editing.id}
                  onClick={() => selectWorkspace(workspace)}
                >
                  {workspace.name}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="off"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-sm">Projects</span>
            {groups.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No projects on your connected environments yet.
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-md border">
                {groups.map((group) => {
                  const owner = ownerOf(group);
                  const ownerName =
                    owner !== null && owner !== editing?.id
                      ? workspaces.find((workspace) => workspace.id === owner)?.name
                      : undefined;
                  return (
                    <label
                      key={group.projectKey}
                      className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm not-last:border-b"
                    >
                      <Checkbox
                        checked={selection.has(group.projectKey)}
                        onCheckedChange={(checked) =>
                          setSelection((previous) => {
                            const next = new Set(previous);
                            if (checked) next.add(group.projectKey);
                            else next.delete(group.projectKey);
                            return next;
                          })
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
                      {ownerName !== undefined ? (
                        <span className="shrink-0 text-muted-foreground text-xs">
                          Moves from {ownerName}
                        </span>
                      ) : group.remoteEnvironmentLabels.length > 0 ? (
                        <span className="shrink-0 truncate text-muted-foreground text-xs">
                          {group.remoteEnvironmentLabels.join(", ")}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        {editing !== null ? (
          <Button
            className="sm:mr-auto"
            type="button"
            variant={confirmingDelete ? "destructive" : "destructive-outline"}
            onClick={() => (confirmingDelete ? remove() : setConfirmingDelete(true))}
          >
            {confirmingDelete ? "Delete; projects go back to Personal" : "Delete workspace"}
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={trimmedName.length === 0}>
          {editing === null ? "Create workspace" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function WorkspaceDialog() {
  const dialog = useWorkspacesStore((state) => state.dialog);
  const close = () => openWorkspaceDialog(null);
  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        {dialog !== null ? (
          <WorkspaceEditor
            key={dialog.kind === "manage" ? `manage:${dialog.workspaceId}` : "create"}
            dialog={dialog}
            onClose={close}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
