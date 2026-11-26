// Banneret Hub: the palette's "Show ports". With a thread or draft open it opens the Ports panel
// in that view's right panel; with neither it opens the Ports dialog, asking which environment
// first when more than one is connected (the same submenu shape as "Forwarded ports").
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { CableIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { openPortsDialog } from "~/state/banneretPorts";
import { useEnvironments } from "~/state/environments";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";

const SEARCH_TERMS = ["ports", "forward", "port forwarding", "localhost", "tunnel", "listening"];

export function useCommandPaletteShowPortsItem(input: {
  /** The open thread's or draft's right panel; null when neither is open. */
  readonly panelRef: ScopedThreadRef | null;
}): CommandPaletteActionItem | CommandPaletteSubmenuItem | null {
  const { environments } = useEnvironments();
  const { panelRef } = input;
  if (panelRef !== null) {
    return {
      kind: "action",
      value: "action:open-ports",
      searchTerms: SEARCH_TERMS,
      title: "Show ports",
      icon: <CableIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        useRightPanelStore.getState().open(panelRef, "ports");
      },
    };
  }
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const [only] = connected;
  if (only === undefined) return null;
  if (connected.length === 1) {
    return {
      kind: "action",
      value: "action:open-ports",
      searchTerms: [...SEARCH_TERMS, only.label],
      title: "Show ports",
      description: only.label,
      icon: <CableIcon className={ITEM_ICON_CLASS} />,
      run: async () => openPortsDialog(only.environmentId),
    };
  }
  const environmentItem = (environment: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }): CommandPaletteActionItem => ({
    kind: "action",
    value: `ports:environment:${environment.environmentId}`,
    searchTerms: [environment.label],
    title: environment.label,
    icon: <CableIcon className={ITEM_ICON_CLASS} />,
    run: async () => openPortsDialog(environment.environmentId),
  });
  return {
    kind: "submenu",
    value: "action:open-ports",
    searchTerms: SEARCH_TERMS,
    title: "Show ports",
    icon: <CableIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <CableIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "ports-environments",
        label: "Environments",
        items: connected.map(environmentItem),
      },
    ],
  };
}
