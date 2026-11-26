// Banneret Hub: the open tabs bar. Click activates, double-click keeps, middle-click closes, drag
// reorders. A thread tab reads its live title from the quiet shell (one subscription per tab, at
// most MAX_TABS, on data the client already holds).
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import { EllipsisIcon, PinIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { readEnvironment, useConnectedEnvironmentIds } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { setActiveWorkspace, useWorkspaces, useWorkspacesStore } from "../workspacesStore";
import type { Tab } from "./tabs.logic";
import { syncTabsWithRoute } from "./tabsRoute";
import {
  beginActivation,
  close,
  endActivation,
  keep,
  move,
  pin,
  retitle,
  setTabsHidden,
  useTabsStore,
} from "./tabsStore";

const TAB_DRAG_TYPE = "application/x-banneret-tab";

/** Shows a tab: a page tab switches its workspace first; a thread tab's workspace follows itself. */
async function activateTab(router: AnyRouter, tab: Tab) {
  if (tab.kind === "thread") {
    await router.navigate({ href: tab.href });
    return;
  }
  beginActivation(tab);
  try {
    setActiveWorkspace(tab.workspaceId);
    await router.navigate({ href: tab.href });
  } finally {
    endActivation();
    syncTabsWithRoute(router);
  }
}

async function closeTab(router: AnyRouter, id: string) {
  const { closedActive, next } = close(new Set([id]));
  if (!closedActive) return;
  if (next === null) await router.navigate({ to: "/" });
  else await activateTab(router, next);
}

function toScopedRef(tab: Tab): ScopedThreadRef | null {
  return tab.threadRef === null
    ? null
    : scopeThreadRef(
        EnvironmentId.make(tab.threadRef.environmentId),
        ThreadId.make(tab.threadRef.threadId),
      );
}

/**
 * Closes the tab once its thread is gone: the shell marks it deleted or archived, or it left the
 * shell while this window watched and its environment stayed live. A thread the shell never listed
 * (older settled, idle subagents, linked threads) stays open; its own route shows what happened.
 */
function ThreadGoneWatcher(props: {
  tabId: string;
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
  const router = useRouter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a thread deleted or archived elsewhere closes its tab
  useEffect(() => {
    if (gone) void closeTab(router, props.tabId);
  }, [gone, router, props.tabId]);
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
  onDragStart: (event: DragEvent, id: string) => void;
  onDrop: (event: DragEvent, beforeId: string) => void;
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
    tab.kind === "page"
      ? `${tab.title} · ${props.workspaceName ?? "Personal"}`
      : (liveTitle ?? tab.title);
  const machine = tab.threadRef
    ? readEnvironment(EnvironmentId.make(tab.threadRef.environmentId))?.label
    : undefined;
  const offlineNote = `On ${machine ?? "a machine"}, not connected`;
  const itemRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- brings the active tab into view in a bar that scrolls sideways
  useEffect(() => {
    if (active) itemRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const sentAt =
    shell === null ? undefined : (shell.latestUserAuthoredMessageAt ?? shell.latestUserMessageAt);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            ref={itemRef}
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            draggable
            data-tab-id={tab.id}
            data-preview={tab.kept ? undefined : ""}
            data-pinned={tab.pinned ? "" : undefined}
            data-offline={props.offline ? "" : undefined}
            className={cn(
              "group/tab relative flex h-7 max-w-52 min-w-0 shrink-0 cursor-default select-none items-center gap-1 rounded-md border border-transparent ps-2 pe-1 text-xs [-webkit-app-region:no-drag]",
              active
                ? "border-border bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              !tab.kept && "italic",
              props.offline && "opacity-50",
            )}
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
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void activateTab(router, tab);
              }
            }}
            onDragStart={(event) => props.onDragStart(event, tab.id)}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(TAB_DRAG_TYPE)) event.preventDefault();
            }}
            onDrop={(event) => props.onDrop(event, tab.id)}
          />
        }
      >
        {threadRef !== null ? (
          <ThreadGoneWatcher tabId={tab.id} threadRef={threadRef} shell={shell} />
        ) : null}
        {active && !tab.kept && threadRef !== null ? (
          <SendKeeper key={tab.id} tabId={tab.id} sentAt={sentAt} />
        ) : null}
        <span className="min-w-0 truncate">{title}</span>
        <button
          type="button"
          aria-label={tab.pinned ? `Unpin ${title}` : `Pin ${title}`}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted",
            !tab.pinned && "hidden group-hover/tab:flex",
          )}
          onClick={(event) => {
            event.stopPropagation();
            pin(tab.id);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <PinIcon className={cn("size-3", tab.pinned && "fill-current")} />
        </button>
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
  const tabs = useTabsStore((state) => state.tabs);
  const activeId = useTabsStore((state) => state.activeId);
  const connected = useConnectedEnvironmentIds();
  const workspaces = useWorkspaces();
  const allWorkspacesLoaded = useWorkspacesStore(
    (state) =>
      connected.length > 0 && connected.every((id) => Object.hasOwn(state.byEnvironment, id)),
  );
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const router = useRouter();

  // A deleted workspace closes its page tabs once every connected environment has answered.
  const goneWorkspaceTabs = allWorkspacesLoaded
    ? tabs
        .filter((tab) => tab.workspaceId !== null && !workspaceNames.has(tab.workspaceId))
        .map((tab) => tab.id)
        .join(",")
    : "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a workspace deleted elsewhere closes its page tabs
  useEffect(() => {
    for (const id of goneWorkspaceTabs.split(",")) if (id !== "") void closeTab(router, id);
  }, [goneWorkspaceTabs, router]);

  const onDragStart = (event: DragEvent, id: string) => {
    event.dataTransfer.setData(TAB_DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = "move";
  };
  const onDrop = (event: DragEvent, beforeId: string | null) => {
    const id = event.dataTransfer.getData(TAB_DRAG_TYPE);
    if (id === "") return;
    event.preventDefault();
    event.stopPropagation();
    move(id, beforeId);
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="Open tabs"
        className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(TAB_DRAG_TYPE)) event.preventDefault();
        }}
        onDrop={(event) => onDrop(event, null)}
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
            onDragStart={onDragStart}
            onDrop={onDrop}
          />
        ))}
      </div>
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
