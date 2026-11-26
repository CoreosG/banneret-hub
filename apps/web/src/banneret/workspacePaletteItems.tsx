// Banneret Hub: "Switch workspace…" and "New workspace…" in the command palette.
import { LayersIcon, PlusIcon } from "lucide-react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../components/CommandPalette.logic";
import { effectiveWorkspaceId } from "./workspaces.logic";
import {
  openWorkspaceDialog,
  setActiveWorkspace,
  useWorkspaces,
  useWorkspacesStore,
} from "./workspacesStore";

export function useCommandPaletteWorkspaceItems(): Array<
  CommandPaletteActionItem | CommandPaletteSubmenuItem
> {
  const workspaces = useWorkspaces();
  const activeId = effectiveWorkspaceId(
    useWorkspacesStore((state) => state.activeId),
    workspaces,
  );
  const targets = [
    { id: null, name: "Personal" },
    ...workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
  ];
  return [
    {
      kind: "submenu",
      value: "action:switch-workspace",
      searchTerms: ["workspace", "switch", "personal", ...workspaces.map((entry) => entry.name)],
      title: "Switch workspace…",
      icon: <LayersIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <LayersIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "workspaces",
          label: "Workspaces",
          items: targets.map((target): CommandPaletteActionItem => ({
            kind: "action",
            value: `workspace:${target.id ?? "personal"}`,
            searchTerms: [target.name],
            title: target.name,
            icon: <LayersIcon className={ITEM_ICON_CLASS} />,
            checked: target.id === activeId,
            run: async () => setActiveWorkspace(target.id),
          })),
        },
      ],
    },
    {
      kind: "action",
      value: "action:new-workspace",
      searchTerms: ["workspace", "new", "create", "projects"],
      title: "New workspace…",
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => openWorkspaceDialog({ kind: "create" }),
    },
  ];
}
