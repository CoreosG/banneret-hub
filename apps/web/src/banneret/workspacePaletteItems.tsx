// Banneret Hub: "Switch workspace…", "New workspace…", "Show/Hide tabs bar" and, while a company is
// shown, "Search the company…" in the command palette.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCommandPaletteShowPortsItem } from "../components/ports/showPortsCommand";
import { usePrimaryEnvironmentId } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { changePause, usePause } from "./Pause";
import { reviewMyWorkflow } from "./workflowPalette";
import { useEnvironmentFeed } from "./relayFeedStore";
import { useNavigate } from "@tanstack/react-router";
import {
  ClipboardCheckIcon,
  PauseIcon,
  LayersIcon,
  PanelTopIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../components/CommandPalette.logic";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { openCompanySearch, useCompanySearchStore } from "./companySearchStore";
import { setTabsHidden, useTabsStore } from "./tabs/tabsStore";
import { effectiveWorkspaceId } from "./workspaces.logic";
import {
  openWorkspaceDialog,
  setActiveWorkspace,
  useWorkspaces,
  useWorkspacesStore,
} from "./workspacesStore";

/**
 * Resolves once the palette has left the screen (about a second at most), so its focus return lands
 * before a dialog opened from it takes focus, not after.
 */
function paletteGone(): Promise<void> {
  return new Promise((resolve) => {
    let frames = 0;
    const check = () => {
      if (!isCommandPaletteOpen() || frames++ > 60) resolve();
      else requestAnimationFrame(check);
    };
    check();
  });
}

export function useBanneretPaletteItems(
  panelRef: ScopedThreadRef | null,
): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const showPorts = useCommandPaletteShowPortsItem({ panelRef });
  const navigate = useNavigate();
  const machine = usePrimaryEnvironmentId();
  const pause = usePause((s) => machine && s[machine]?.status);
  const workspaces = useWorkspaces();
  const tabsHidden = useTabsStore((state) => state.hidden);
  const searchAvailable = useCompanySearchStore((state) => state.available);
  const activeId = effectiveWorkspaceId(
    useWorkspacesStore((state) => state.activeId),
    workspaces,
  );
  // Only a company workspace has a main orchestrator chat.
  const relayOrigin = workspaces.find((w) => w.id === activeId && w.kind === "enterprise")?.relay
    ?.origin;
  const relayFeed = useEnvironmentFeed(
    machine && relayOrigin ? { environmentId: machine, relayOrigin } : null,
  );
  const targets = [
    { id: null, name: "Personal" },
    ...workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
  ];
  const search: CommandPaletteActionItem[] = searchAvailable
    ? [
        {
          kind: "action",
          value: "action:search-company",
          searchTerms: ["search", "find", "company", "tasks", "board", "map", "feed"],
          title: "Search the company…",
          icon: <SearchIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            await paletteGone();
            openCompanySearch();
          },
        },
      ]
    : [];
  return [
    ...(showPorts ? [showPorts] : []),
    ...search,
    ...(machine && pause
      ? [
          {
            kind: "action" as const,
            value: "action:pause-everything",
            title: pause.paused ? "Resume automatic work" : "Pause everything",
            searchTerms: ["pause", "stop", "new work", "resume"],
            icon: <PauseIcon className={ITEM_ICON_CLASS} />,
            run: () => changePause(machine, { kind: pause.paused ? "resume" : "pause" }),
          },
        ]
      : []),
    ...(machine && relayOrigin && !relayFeed.elsewhere?.memory
      ? [
          {
            kind: "action" as const,
            value: "action:review-my-workflow",
            title: "Review my workflow",
            searchTerms: ["review", "workflow", "agents", "retries"],
            icon: <ClipboardCheckIcon className={ITEM_ICON_CLASS} />,
            run: () =>
              reviewMyWorkflow({ environmentId: machine, relayOrigin }, (ref) =>
                navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) }),
              ),
          },
        ]
      : []),
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
      value: "action:toggle-tabs-bar",
      searchTerms: ["tabs", "tab bar", "open tabs", tabsHidden ? "show" : "hide"],
      title: tabsHidden ? "Show tabs bar" : "Hide tabs bar",
      icon: <PanelTopIcon className={ITEM_ICON_CLASS} />,
      run: async () => setTabsHidden(!tabsHidden),
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
