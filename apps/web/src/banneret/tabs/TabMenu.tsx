// Banneret Hub: a tab's context menu, opened at the pointer or under the tab from the keyboard.
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { useRouter } from "@tanstack/react-router";

import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { m } from "../../i18n/messages";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { closeAndShow, closeTab, toScopedRef } from "./tabActions";
import type { Tab } from "./tabs.logic";
import { keep, pin } from "./tabsStore";

/** A closed menu keeps its target while the popup leaves and focus returns to the tab. */
export interface TabMenuState {
  readonly open: boolean;
  readonly tabId: string;
  readonly element: HTMLElement;
  readonly x: number;
  readonly y: number;
}

/**
 * Copies the tab's link, or null when it has none. A thread copies what the thread menu's Copy >
 * Thread does. A page has only this app's own address, which is a link in a web client alone; an
 * unsent draft exists nowhere else.
 */
export function linkCopier(
  tab: Pick<Tab, "kind" | "href" | "threadRef" | "title">,
): (() => void) | null {
  if (tab.kind === "thread") {
    const threadRef = toScopedRef(tab);
    if (threadRef === null || tab.href.startsWith("/draft/")) return null;
    return () =>
      void copyThreadReference(
        threadChipCopyTarget(threadRef, tab.title, configuredHostedAppUrl(), m),
      );
  }
  if (!window.location.protocol.startsWith("http")) return null;
  return () =>
    void writeTextToClipboard(new URL(tab.href, window.location.origin).href).catch(() => {
      toastManager.add({ type: "error", title: "Failed to copy link" });
    });
}

export function TabMenu(props: {
  menu: TabMenuState;
  tabs: ReadonlyArray<Tab>;
  onClose: () => void;
}) {
  const router = useRouter();
  const { menu, tabs } = props;
  const index = tabs.findIndex((tab) => tab.id === menu.tabId);
  const tab = tabs[index];
  // The tab can close elsewhere while its menu is open (its thread was deleted).
  if (tab === undefined) return null;
  // Bulk closes spare pinned tabs.
  const closable = (candidates: ReadonlyArray<Tab>) =>
    new Set(candidates.filter((other) => other !== tab && !other.pinned).map((other) => other.id));
  const others = closable(tabs);
  const toTheRight = closable(tabs.slice(index + 1));
  const copyLink = linkCopier(tab);
  return (
    <Menu
      open={menu.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <MenuPopup
        aria-label="Tab actions"
        align="start"
        sideOffset={0}
        anchor={{ getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0) }}
        finalFocus={() => (menu.element.isConnected ? menu.element : false)}
      >
        <MenuItem onClick={() => void closeTab(router, tab.id)}>Close</MenuItem>
        <MenuItem
          disabled={others.size === 0}
          onClick={() => void closeAndShow(router, others, tab)}
        >
          Close others
        </MenuItem>
        <MenuItem
          disabled={toTheRight.size === 0}
          onClick={() => void closeAndShow(router, toTheRight, tab)}
        >
          Close to the right
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => pin(tab.id)}>{tab.pinned ? "Unpin" : "Pin"}</MenuItem>
        <MenuItem disabled={tab.kept} onClick={() => keep(tab.id)}>
          Keep
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={copyLink === null} onClick={() => copyLink?.()}>
          Copy link
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
