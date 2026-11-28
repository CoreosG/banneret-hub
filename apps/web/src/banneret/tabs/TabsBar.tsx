// Banneret Hub: the open chats tabs bar. Click activates, double-click keeps, middle-click closes,
// right-click (or Shift+F10) opens the tab menu. A thread tab reads its live title from the quiet
// shell (one subscription per tab, at most MAX_TABS, on data already held).
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { PinIcon, XIcon } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { openContextMenuFromKeyboard } from "../../contextMenuSource";
import { useQuietThreadShell } from "../../state/entities";
import { readEnvironment, useConnectedEnvironmentIds } from "../../state/environments";
import { useEnterpriseFeed } from "../useEnterpriseFeed";
import { useWorkspaces } from "../workspacesStore";
import { activateTab, closeTab, toScopedRef } from "./tabActions";
import { TabMenu, type TabMenuState } from "./TabMenu";
import {
  moveTabFocus,
  TAB_BUTTON_CLASS_NAME,
  tabClassName,
  TabStrip,
  TabTitle,
  useKeepTabInView,
} from "./tabStrip";
import type { Tab } from "./tabs.logic";
import { close, keep, move, pin, retitle, useTabsStore } from "./tabsStore";
import { useThreadGone } from "./useThreadGone";

/** A page's tab also says which workspace the page belongs to. */
function tabTitle(tab: Tab, workspaceNames: ReadonlyMap<string, string>) {
  if (tab.kind === "thread") return tab.title;
  const workspace = tab.workspaceId === null ? "Personal" : workspaceNames.get(tab.workspaceId);
  return workspace === undefined ? tab.title : `${tab.title} · ${workspace}`;
}

/** Closes the tab once its thread is gone (useThreadGone). */
function ThreadGoneWatcher(props: {
  tabId: string;
  active: boolean;
  threadRef: ScopedThreadRef;
  shell: EnvironmentThreadShell | null;
}) {
  const gone = useThreadGone(props.threadRef, props.shell);
  // The active tab stays: its route already handles a missing thread. It closes once left.
  const closeNow = gone && !props.active;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a thread deleted or archived elsewhere closes its tab
  useEffect(() => {
    if (closeNow) close(new Set([props.tabId]));
  }, [closeNow, props.tabId]);
  return null;
}

/**
 * A preview thread tab becomes kept once a message is sent in it: the shell's latest user message
 * moves past the one it showed when the tab became active. Remounted per tab, so each activation
 * takes a fresh baseline once the shell has loaded.
 */
function SendKeeper({ tabId, sentAt }: { tabId: string; sentAt: string | null | undefined }) {
  const [baseline, setBaseline] = useState(sentAt);
  if (baseline === undefined && sentAt !== undefined) setBaseline(sentAt);
  const sent = baseline !== undefined && sentAt !== undefined && sentAt !== baseline;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a message sent in a preview tab keeps it
  useEffect(() => {
    if (sent) keep(tabId);
  }, [sent, tabId]);
  return null;
}

function TabItem(props: {
  tab: Tab;
  active: boolean;
  offline: boolean;
  workspaceNames: ReadonlyMap<string, string>;
  /** The names of the other tabs in the bar. */
  otherTitles: ReadonlyArray<string>;
  menuOpen: boolean;
  onMenu: (element: HTMLElement, at: { x: number; y: number }) => void;
}) {
  const { tab, active } = props;
  const router = useRouter();
  const threadRef = toScopedRef(tab);
  const shell = useQuietThreadShell(threadRef);
  const liveTitle = shell?.title;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves the live title as the fallback shown before the shell loads
  useEffect(() => {
    if (liveTitle) retitle(tab.id, liveTitle);
  }, [liveTitle, tab.id]);
  const title =
    tab.kind === "thread" ? (liveTitle ?? tab.title) : tabTitle(tab, props.workspaceNames);
  const machine = tab.threadRef
    ? readEnvironment(EnvironmentId.make(tab.threadRef.environmentId))?.label
    : undefined;
  const offlineNote = `On ${machine ?? "a machine"}, not connected`;
  const itemRef = useRef<HTMLDivElement | null>(null);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  useKeepTabInView(itemRef, active);
  const sentAt =
    shell === null ? undefined : (shell.latestUserAuthoredMessageAt ?? shell.latestUserMessageAt);

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
            data-tab-id={tab.id}
            data-preview={tab.kept ? undefined : ""}
            data-pinned={tab.pinned ? "" : undefined}
            data-offline={props.offline ? "" : undefined}
            data-dragging={isDragging ? "" : undefined}
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={tabClassName({
              active,
              preview: !tab.kept,
              offline: props.offline,
              dragging: isDragging,
            })}
            {...listeners}
            onClick={() => void activateTab(router, tab)}
            onDoubleClick={() => keep(tab.id)}
            onMouseDown={(event) => {
              // Middle-click must not start the browser's autoscroll.
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              void closeTab(router, tab.id);
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
                void activateTab(router, tab);
              }
            }}
          />
        }
      >
        {threadRef !== null ? (
          <ThreadGoneWatcher tabId={tab.id} active={active} threadRef={threadRef} shell={shell} />
        ) : null}
        {active && !tab.kept && threadRef !== null ? (
          <SendKeeper key={tab.id} tabId={tab.id} sentAt={sentAt} />
        ) : null}
        <TabTitle title={title} titles={props.otherTitles} />
        {/* Nothing may appear on hover: a tab that grows pushes its close button out of reach. */}
        {tab.pinned ? (
          <button
            type="button"
            aria-label={`Unpin ${title}`}
            className={TAB_BUTTON_CLASS_NAME}
            onClick={(event) => {
              event.stopPropagation();
              pin(tab.id);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
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
            void closeTab(router, tab.id);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <XIcon className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {title}
        {props.offline ? <div className="text-muted-foreground">{offlineNote}</div> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

export function TabsBar() {
  const allTabs = useTabsStore((state) => state.tabs);
  const enterprise = useEnterpriseFeed();
  const tabs = allTabs.filter(
    (tab) =>
      tab.kind !== "chat" ||
      (tab.workspaceId === enterprise?.workspace.id &&
        enterprise.feed.sectionsKnown &&
        enterprise.feed.sections.includes("chat")),
  );
  const activeId = useTabsStore((state) => state.activeId);
  const connected = useConnectedEnvironmentIds();
  const workspaces = useWorkspaces();
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const titles = tabs.map((tab) => tabTitle(tab, workspaceNames));

  return (
    <TabStrip
      label="Open tabs"
      ids={tabs.map((tab) => tab.id)}
      onMove={move}
      menu={
        menu === null ? null : (
          <TabMenu
            menu={menu}
            tabs={tabs}
            onClose={() => setMenu((current) => current && { ...current, open: false })}
          />
        )
      }
    >
      {tabs.map((tab, position) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          offline={
            tab.threadRef !== null &&
            !connected.includes(EnvironmentId.make(tab.threadRef.environmentId))
          }
          workspaceNames={workspaceNames}
          otherTitles={titles.toSpliced(position, 1)}
          menuOpen={menu?.open === true && menu.tabId === tab.id}
          onMenu={(element, at) => setMenu({ open: true, tabId: tab.id, element, ...at })}
        />
      ))}
    </TabStrip>
  );
}
