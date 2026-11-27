// Banneret Hub: create, rename, delete a workspace and choose its projects; the same dialog hosts
// the Enterprise wizard, the Machines list and Leave.
import type { BanneretWorkspace } from "@t3tools/contracts";
import { useId, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { Button } from "../components/ui/button";
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
import { EnterpriseWizard } from "./EnterpriseWizard";
import { LeavePanel, MachinesPanel } from "./MachinesDialog";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { deleteWorkspace } from "./workspaces.logic";
import {
  ownerOfGroup,
  ProjectChecklist,
  usePickableProjectGroups,
  WorkspaceKindChoice,
  workspaceWithProjects,
} from "./WorkspaceProjectPicker";
import {
  openWorkspaceDialog,
  saveWorkspaces,
  setActiveWorkspace,
  useWorkspaces,
  useWorkspacesStore,
  type WorkspaceDialogState,
} from "./workspacesStore";

const MAX_NAME_LENGTH = 60;
function WorkspaceEditor(props: {
  readonly dialog: Extract<WorkspaceDialogState, { kind: "create" | "manage" }>;
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
  const ownerOf = (group: SidebarProjectSnapshot) => ownerOfGroup(group, workspaces);
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
    void saveWorkspaces(
      workspaceWithProjects({
        workspaces,
        workspace: { ...workspace, name: trimmedName },
        groups,
        selection,
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
          {editing === null ? <WorkspaceKindChoice kind="solo" /> : null}
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
            <ProjectChecklist
              groups={groups}
              workspaces={workspaces}
              editingId={editing?.id ?? null}
              selection={selection}
              onToggle={(projectKey, checked) =>
                setSelection((previous) => {
                  const next = new Set(previous);
                  if (checked) next.add(projectKey);
                  else next.delete(projectKey);
                  return next;
                })
              }
            />
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

function dialogBody(dialog: Exclude<WorkspaceDialogState, null>, close: () => void) {
  switch (dialog.kind) {
    case "create":
    case "manage":
      return (
        <WorkspaceEditor
          key={dialog.kind === "manage" ? `manage:${dialog.workspaceId}` : "create"}
          dialog={dialog}
          onClose={close}
        />
      );
    case "enterprise":
      return (
        <EnterpriseWizard
          key={JSON.stringify(dialog)}
          selectedId={dialog.environmentId}
          initialOrigin={dialog.origin}
          onClose={close}
        />
      );
    case "machines":
      return <MachinesPanel key={dialog.origin} origin={dialog.origin} onClose={close} />;
    case "leave":
      return (
        <LeavePanel
          selectedId={dialog.environmentId}
          key={JSON.stringify(dialog)}
          origin={dialog.origin}
          onClose={close}
        />
      );
  }
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
        {dialog !== null ? dialogBody(dialog, close) : null}
      </DialogPopup>
    </Dialog>
  );
}
