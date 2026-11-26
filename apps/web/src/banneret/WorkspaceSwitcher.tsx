// Banneret Hub: the sidebar brand mark doubles as the workspace switcher.
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, HouseIcon, PlusIcon, Settings2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { effectiveWorkspaceId } from "./workspaces.logic";
import {
  openWorkspaceDialog,
  setActiveWorkspace,
  useWorkspaces,
  useWorkspacesStore,
} from "./workspacesStore";

// Radio values are strings; Personal has no id of its own.
const PERSONAL_VALUE = "";

export function WorkspaceSwitcher(props: {
  /** The brand's own label, so the upstream string stays in use. */
  readonly ariaLabel: string;
  readonly onBackdrop: boolean;
  readonly children: ReactNode;
}) {
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const activeId = effectiveWorkspaceId(
    useWorkspacesStore((state) => state.activeId),
    workspaces,
  );
  const activeName =
    activeId === null ? null : workspaces.find((workspace) => workspace.id === activeId)?.name;

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={props.ariaLabel}
            className={cn(
              "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink items-center gap-1.5 overflow-hidden rounded-md px-1 outline-hidden ring-ring [-webkit-app-region:no-drag] hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset md:flex",
              props.onBackdrop ? "text-white hover:bg-white/10" : "text-foreground",
            )}
          />
        }
      >
        {props.children}
        {activeName ? (
          <span
            className={cn(
              "min-w-0 truncate text-xs",
              props.onBackdrop ? "text-white/70" : "text-muted-foreground",
            )}
          >
            {activeName}
          </span>
        ) : null}
        <ChevronsUpDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0",
            props.onBackdrop ? "text-white/70" : "text-muted-foreground",
          )}
        />
      </MenuTrigger>
      <MenuPopup align="start" sideOffset={6} className="min-w-56">
        <MenuRadioGroup
          value={activeId ?? PERSONAL_VALUE}
          onValueChange={(value) => setActiveWorkspace(value === PERSONAL_VALUE ? null : value)}
        >
          <WorkspaceRadioItem value={PERSONAL_VALUE} name="Personal" />
          {workspaces.map((workspace) => (
            <WorkspaceRadioItem key={workspace.id} value={workspace.id} name={workspace.name} />
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={() => openWorkspaceDialog({ kind: "create" })}>
          <PlusIcon />
          New workspace…
        </MenuItem>
        <MenuItem onClick={() => openWorkspaceDialog({ kind: "manage", workspaceId: activeId })}>
          <Settings2Icon />
          Manage workspaces
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/" })}>
          <HouseIcon />
          Home
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// The active workspace carries a check, as upstream's selection menus do. Picking one closes the
// menu, since the sidebar behind it changes.
function WorkspaceRadioItem(props: { readonly value: string; readonly name: string }) {
  return (
    <MenuRadioItem value={props.value} closeOnClick>
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{props.name}</span>
        <MenuRadioItemIndicator />
      </span>
    </MenuRadioItem>
  );
}
