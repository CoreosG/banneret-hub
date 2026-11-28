// Banneret Hub: with Workspaces tabs, the sidebar's list of every workspace. Picking one shows it
// and brings its tab back if it was closed.
import { useRouter } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, FolderIcon } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../components/ui/sidebar";
import {
  environmentNames,
  useWorkspaceTabsInEffect,
  useWorkspaceTabsView,
} from "./tabs/useProjectWorkspaces";
import { showWorkspace } from "./tabs/workspaceTabsActions";

function List() {
  const router = useRouter();
  const { workspaces, tabs, shown } = useWorkspaceTabsView();
  const open = new Set(tabs.map((tab) => tab.workspace.key));
  const listed = workspaces.filter((w) => !w.archived || open.has(w.key));
  // Machines tell two workspaces apart only when there is more than one.
  const severalMachines = new Set(listed.flatMap(environmentNames)).size > 1;
  if (listed.length === 0) return null;
  return (
    <SidebarGroup className="shrink-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <Menu>
            <MenuTrigger render={<SidebarMenuButton aria-label="Workspaces" />}>
              <FolderIcon />
              <span className="min-w-0 flex-1 truncate">{shown?.name ?? "All workspaces"}</span>
              <ChevronsUpDownIcon aria-hidden className="size-3 text-muted-foreground" />
            </MenuTrigger>
            <MenuPopup align="start" sideOffset={4} className="w-72">
              {listed.map((workspace) => {
                const machines = severalMachines ? environmentNames(workspace).join(", ") : "";
                const note = [machines, open.has(workspace.key) ? "" : "No tab"]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <MenuItem
                    key={workspace.key}
                    aria-current={workspace.key === shown?.key ? "true" : undefined}
                    onClick={() => void showWorkspace(router, workspace)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      {/* Wrapped, not cut: long names often differ only at the end. */}
                      <span className="break-words">{workspace.name}</span>
                      {note === "" ? null : (
                        <span className="break-words text-muted-foreground text-xs">{note}</span>
                      )}
                    </span>
                    {workspace.key === shown?.key ? <CheckIcon aria-hidden /> : null}
                  </MenuItem>
                );
              })}
            </MenuPopup>
          </Menu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

export function SidebarWorkspaceList() {
  return useWorkspaceTabsInEffect() ? <List /> : null;
}
