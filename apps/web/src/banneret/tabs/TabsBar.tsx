// Banneret Hub: the open tabs bar. Click activates, double-click keeps, middle-click closes,
// right-click (or Shift+F10) opens the tab menu. Drag reorders with pointer events (dnd-kit), since
// HTML5 drag events miss the desktop window's drag region on Windows. A thread tab reads its live
// title from the quiet shell (one subscription per tab, at most MAX_TABS, on data already held).
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { EllipsisIcon, PinIcon, XIcon } from "lucide-react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { openContextMenuFromKeyboard } from "../../contextMenuSource";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { readEnvironment, useConnectedEnvironmentIds } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { useEnterpriseFeed } from "../useEnterpriseFeed";
import { useWorkspaces } from "../workspacesStore";
import { activateTab, closeTab, toScopedRef } from "./tabActions";
import { TabMenu, type TabMenuState } from "./TabMenu";
import type { Tab } from "./tabs.logic";
import { close, keep, move, pin, retitle, setTabsHidden, useTabsStore } from "./tabsStore";

const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

/**
 * Closes the tab once its thread is gone: the shell marks it deleted or archived, or it left the
 * shell while this window watched and its environment stayed live. A thread the shell never listed
 * (older settled, idle subagents, linked threads) stays open; its own route shows what happened.
 */
function ThreadGoneWatcher(props: {
  tabId: string;
  active: boolean;
  threadRef: ScopedThreadRef;
  shell: EnvironmentThreadShell | null;
}) {
  const { shell, threadRef } = props;
  const live =
    useAtomValue(environmentShell.stateValueAtom(threadRef.environmentId)).status === "live";
  const hasDraft = useComposerDraftStore((store) => store.getDraftSessionByRef(threadRef) !== null);
  // Whether this window saw the thread in a live shell since the environment last went live.
  const [seen, setSeen] = useState(false);
  const seenNow = live && (shell !== null || seen);
  if (seenNow !== seen) setSeen(seenNow);
  const gone =
    !hasDraft &&
    (shell !== null ? shell.deletedAt !== null || shell.archivedAt !== null : live && seen);
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
  workspaceName: string | undefined;
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
  const workspaceLabel = tab.workspaceId === null ? "Personal" : props.workspaceName;
  const title =
    tab.kind === "thread"
      ? (liveTitle ?? tab.title)
      : workspaceLabel === undefined
        ? tab.title
        : `${tab.title} · ${workspaceLabel}`;
  const machine = tab.threadRef
    ? readEnvironment(EnvironmentId.make(tab.threadRef.environmentId))?.label
    : undefined;
  const offlineNote = `On ${machine ?? "a machine"}, not connected`;
  const itemRef = useRef<HTMLDivElement | null>(null);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the active tab, and so its close button, inside a bar that scrolls sideways
  useEffect(() => {
    const item = itemRef.current;
    const list = item?.closest('[role="tablist"]');
    if (!active || !item || !list) return;
    // Reports once on observe, then whenever the tab or the bar changes width.
    return observeResize([item, list], () =>
      item.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  }, [active]);
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
            data-tab-id={tab.id}
            data-preview={tab.kept ? undefined : ""}
            data-pinned={tab.pinned ? "" : undefined}
            data-offline={props.offline ? "" : undefined}
            data-dragging={isDragging ? "" : undefined}
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={cn(
              "group/tab relative flex h-7 max-w-52 min-w-0 shrink-0 cursor-default select-none items-center gap-1 rounded-md border border-transparent ps-2 pe-1 text-xs [-webkit-app-region:no-drag]",
              active
                ? "border-border bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              !tab.kept && "italic",
              props.offline && "opacity-50",
              isDragging && "z-10",
            )}
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
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                const items = [
                  ...event.currentTarget
                    .closest('[role="tablist"]')!
                    .querySelectorAll<HTMLElement>('[role="tab"]'),
                ];
                const step = event.key === "ArrowLeft" ? -1 : 1;
                items[items.indexOf(event.currentTarget) + step]?.focus();
              }
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
        <span className="min-w-0 truncate">{title}</span>
        {/* Nothing may appear on hover: a tab that grows pushes its close button out of reach. */}
        {tab.pinned ? (
          <button
            type="button"
            aria-label={`Unpin ${title}`}
            className="flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
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
          className="flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const from = tabs.findIndex((tab) => tab.id === active.id);
    const to = tabs.findIndex((tab) => tab.id === over.id);
    if (from === -1 || to === -1) return;
    // Dropped on a tab to its right: it lands after that tab; to its left: before it.
    move(String(active.id), from < to ? (tabs[to + 1]?.id ?? null) : tabs[to]!.id);
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="Open tabs"
        className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={TAB_DRAG_MODIFIERS}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={tabs.map((tab) => tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                offline={
                  tab.threadRef !== null &&
                  !connected.includes(EnvironmentId.make(tab.threadRef.environmentId))
                }
                workspaceName={
                  tab.workspaceId === null ? undefined : workspaceNames.get(tab.workspaceId)
                }
                menuOpen={menu?.open === true && menu.tabId === tab.id}
                onMenu={(element, at) => setMenu({ open: true, tabId: tab.id, element, ...at })}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      {/* Outside the tabs, so the menu's clicks never bubble into one. */}
      {menu === null ? null : (
        <TabMenu
          menu={menu}
          tabs={tabs}
          onClose={() => setMenu((current) => current && { ...current, open: false })}
        />
      )}
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Tabs bar options"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" sideOffset={6}>
          <MenuItem onClick={() => setTabsHidden(true)}>Hide tabs bar</MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}
