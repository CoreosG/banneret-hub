// Banneret Hub: a workspace tab's context menu. The chats menu without Keep (there is no preview),
// and Copy link copies the workspace's last chat.
import { useRouter } from "@tanstack/react-router";

import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../../components/ui/menu";
import { linkCopier, type TabMenuState } from "./TabMenu";
import { closeWorkspaceTabs, type DrawnWorkspaceTabs } from "./workspaceTabsActions";
import { pinWorkspace } from "./workspaceTabsStore";

export function WorkspaceTabMenu(props: {
  menu: TabMenuState;
  drawn: DrawnWorkspaceTabs;
  onClose: () => void;
}) {
  const router = useRouter();
  const { menu, drawn } = props;
  const index = drawn.tabs.findIndex((tab) => tab.entry.key === menu.tabId);
  const tab = drawn.tabs[index];
  // The tab can leave while its menu is open (its project was removed).
  if (tab === undefined) return null;
  // Bulk closes spare pinned tabs.
  const closable = (candidates: DrawnWorkspaceTabs["tabs"]) =>
    new Set(
      candidates
        .filter((other) => other !== tab && !other.entry.pinned)
        .map((other) => other.entry.key),
    );
  const others = closable(drawn.tabs);
  const toTheRight = closable(drawn.tabs.slice(index + 1));
  const chat = tab.entry.lastChat;
  const copyLink =
    chat === null ? null : linkCopier({ kind: "thread", ...chat, title: tab.workspace.name });
  const close = (keys: ReadonlySet<string>) =>
    void closeWorkspaceTabs(router, keys, drawn, tab.workspace);
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
        <MenuItem onClick={() => void closeWorkspaceTabs(router, new Set([tab.entry.key]), drawn)}>
          Close
        </MenuItem>
        <MenuItem disabled={others.size === 0} onClick={() => close(others)}>
          Close others
        </MenuItem>
        <MenuItem disabled={toTheRight.size === 0} onClick={() => close(toTheRight)}>
          Close to the right
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            pinWorkspace(
              tab.entry.key,
              drawn.tabs.map((other) => other.workspace),
            )
          }
        >
          {tab.entry.pinned ? "Unpin" : "Pin"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={copyLink === null} onClick={() => copyLink?.()}>
          Copy link
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
