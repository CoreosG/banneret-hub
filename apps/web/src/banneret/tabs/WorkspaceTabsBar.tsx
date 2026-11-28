// Banneret Hub: "Tabs show: Workspaces", one tab per project. Click shows the workspace with the
// chat last open in it, middle-click closes (hides) the tab, right-click (or Shift+F10) opens the
// tab menu. The sidebar's workspace list brings a closed tab back.
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { PinIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { openContextMenuFromKeyboard } from "../../contextMenuSource";
import { useQuietThreadShell } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { toScopedRef } from "./tabActions";
import type { TabMenuState } from "./TabMenu";
import {
  moveTabFocus,
  TAB_BUTTON_CLASS_NAME,
  tabClassName,
  TabStrip,
  TabTitle,
  useKeepTabInView,
} from "./tabStrip";
import { environmentNames, useWorkspaceTabsView } from "./useProjectWorkspaces";
import { useThreadGone } from "./useThreadGone";
import type { WorkspaceEntry } from "./workspaceTabs.logic";
import { WorkspaceTabMenu } from "./WorkspaceTabMenu";
import { closeWorkspaceTabs, showWorkspace, type DrawnWorkspaceTabs } from "./workspaceTabsActions";
import { forgetChat, moveWorkspaceTab, pinWorkspace } from "./workspaceTabsStore";

/** Forgets a workspace's last chat once its thread is gone (useThreadGone). */
function LastChatGoneWatcher({ entry, active }: { entry: WorkspaceEntry; active: boolean }) {
  const ref = entry.lastChat === null ? null : toScopedRef(entry.lastChat);
  const gone = useThreadGone(ref, useQuietThreadShell(ref));
  // The chat in front stays: its route already handles a missing thread.
  const forgetNow = gone && !active;
  const href = entry.lastChat?.href;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a thread deleted or archived elsewhere is no longer where its workspace was left
  useEffect(() => {
    if (forgetNow && href !== undefined) forgetChat(href);
  }, [forgetNow, href]);
  return null;
}

function WorkspaceTabItem(props: {
  tab: DrawnWorkspaceTabs["tabs"][number];
  drawn: DrawnWorkspaceTabs;
  offline: boolean;
  menuOpen: boolean;
  /** Every name in the bar. */
  titles: ReadonlyArray<string>;
  onMenu: (element: HTMLElement, at: { x: number; y: number }) => void;
}) {
  const { entry, workspace } = props.tab;
  const active = entry.key === props.drawn.shownKey;
  const router = useRouter();
  const title = workspace.name;
  const machines = environmentNames(workspace).join(", ");
  const itemRef = useRef<HTMLDivElement | null>(null);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.key,
  });
  useKeepTabInView(itemRef, active);
  const show = () => void showWorkspace(router, workspace);
  const close = () => void closeWorkspaceTabs(router, new Set([entry.key]), props.drawn);

  return (
    // The tooltip would sit on top of the tab menu.
    <Tooltip disabled={props.menuOpen}>
      <TooltipTrigger
        render={
          <div
            ref={(node: HTMLDivElement | null) => {
              itemRef.current = node;
              setNodeRef(node);
            }}
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            aria-label={title}
            data-tab-id={entry.key}
            data-pinned={entry.pinned ? "" : undefined}
            data-offline={props.offline ? "" : undefined}
            data-dragging={isDragging ? "" : undefined}
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={tabClassName({ active, offline: props.offline, dragging: isDragging })}
            {...listeners}
            onClick={show}
            onMouseDown={(event) => {
              // Middle-click must not start the browser's autoscroll.
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              close();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onMenu(event.currentTarget, { x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              // Keys on the tab's own buttons are theirs.
              if (event.target !== event.currentTarget) return;
              openContextMenuFromKeyboard(event);
              moveTabFocus(event);
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                show();
              }
            }}
          />
        }
      >
        {entry.lastChat === null ? null : (
          <LastChatGoneWatcher key={entry.lastChat.href} entry={entry} active={active} />
        )}
        <TabTitle title={title} titles={props.titles} />
        {/* Nothing may appear on hover: a tab that grows pushes its close button out of reach. */}
        {entry.pinned ? (
          <button
            type="button"
            aria-label={`Unpin ${title}`}
            className={TAB_BUTTON_CLASS_NAME}
            onClick={(event) => {
              event.stopPropagation();
              pinWorkspace(
                entry.key,
                props.drawn.tabs.map((other) => other.workspace),
              );
            }}
          >
            <PinIcon className="size-3 fill-current" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Close ${title}`}
          className={TAB_BUTTON_CLASS_NAME}
          onClick={(event) => {
            event.stopPropagation();
            close();
          }}
        >
          <XIcon className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {title}
        {machines === "" ? null : (
          <div className="text-muted-foreground">
            {props.offline ? `On ${machines}, not connected` : `On ${machines}`}
          </div>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

export function WorkspaceTabsBar() {
  const { tabs, shown } = useWorkspaceTabsView();
  const connected = useConnectedEnvironmentIds();
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const drawn: DrawnWorkspaceTabs = {
    tabs,
    shownKey: tabs.find((tab) => tab.workspace.key === shown?.key)?.entry.key ?? null,
  };
  const titles = tabs.map((tab) => tab.workspace.name);

  return (
    <TabStrip
      label="Workspace tabs"
      ids={tabs.map((tab) => tab.entry.key)}
      onMove={(key, beforeKey) =>
        moveWorkspaceTab(
          key,
          beforeKey,
          tabs.map((tab) => tab.workspace),
        )
      }
      menu={
        menu === null ? null : (
          <WorkspaceTabMenu
            menu={menu}
            drawn={drawn}
            onClose={() => setMenu((current) => current && { ...current, open: false })}
          />
        )
      }
    >
      {tabs.map((tab) => (
        <WorkspaceTabItem
          key={tab.entry.key}
          tab={tab}
          drawn={drawn}
          titles={titles}
          offline={tab.workspace.projects.every(
            (project) => !connected.includes(EnvironmentId.make(project.environmentId)),
          )}
          menuOpen={menu?.open === true && menu.tabId === tab.entry.key}
          onMenu={(element, at) => setMenu({ open: true, tabId: tab.entry.key, element, ...at })}
        />
      ))}
    </TabStrip>
  );
}
