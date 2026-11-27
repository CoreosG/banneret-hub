// Banneret Hub: the company rows above the thread list (Today, Needs you with its count, the Board,
// the Map, the Feed and the Team), shown only for an Enterprise workspace this machine has joined, and only for sections the
// relay offers. Board, Map and Feed open with the filters last set on them in this window.
import { ChannelRows } from "./chat/ChannelRows";
import { useEffect } from "react";
import { useConnectedEnvironmentIds } from "../state/environments";
import { relayKey, useEnrolmentStore } from "./enrolmentStore";
import { useQuietThreadShell } from "../state/entities";
import { useRefreshInactiveDesignation } from "./OrchestratorMarker";
import { useOrchestrators, selectOrchestrator } from "./orchestratorStore";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  InboxIcon,
  MapIcon,
  SquareKanbanIcon,
  SunIcon,
  UsersIcon,
} from "lucide-react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { restoredSearch } from "./filterMemory";
import { needsCountLabel, offersSection } from "./relayFeed.logic";
import { useEnterpriseFeed } from "./useEnterpriseFeed";

export function EnterpriseSidebarRows() {
  const enterprise = useEnterpriseFeed();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = enterprise?.environmentId;
  const relayOrigin = enterprise?.target.relayOrigin;
  const connected = useConnectedEnvironmentIds();
  const views = useEnrolmentStore((state) => state.views);
  const login = enterprise?.enrolment.me?.login.toLowerCase();
  const main = useOrchestrators(
    (state) => enterprise && state.byRelay[relayKey(enterprise.target)]?.main,
  );
  const pinned = useQuietThreadShell(
    environmentId && main ? { environmentId, threadId: main } : null,
  );
  const pinInactive = useRefreshInactiveDesignation(pinned, environmentId, relayOrigin);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the designation from the selected company's machine
  useEffect(() => {
    if (!login || !relayOrigin) return;
    for (const id of connected) {
      if (
        views[id]?.some(
          (view) =>
            view.state === "configured" &&
            view.relayOrigin === relayOrigin &&
            view.me?.login.toLowerCase() === login,
        )
      )
        void selectOrchestrator({ environmentId: id, relayOrigin }, { relayOrigin, action: "get" });
    }
  }, [connected, views, login, relayOrigin]);
  if (enterprise === null) return null;
  const { feed, workspace } = enterprise;
  const showToday = offersSection(feed, "today");
  const showNeeds = offersSection(feed, "needs");
  const showBoard = offersSection(feed, "board");
  const showMap = offersSection(feed, "map");
  const showFeed = offersSection(feed, "feed");
  const showTeam = offersSection(feed, "team");

  const go = (to: "/today" | "/needs" | "/board" | "/map" | "/feed" | "/team") => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to,
      search: restoredSearch(workspace.id, to, feed.board?.value ?? null),
    } as never);
  };
  const count = needsCountLabel({
    needsCount: feed.needsCount,
    loaded: feed.needs?.length ?? null,
    more: feed.needsNextCursor !== null,
  });
  return (
    <SidebarGroup className="shrink-0">
      <SidebarMenu aria-label={workspace.name}>
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={async () => {
              const selection = await selectOrchestrator(enterprise.target, {
                relayOrigin: enterprise.target.relayOrigin,
                action: "ensure",
              });
              if (selection?.main) {
                if (isMobile) setOpenMobile(false);
                await navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: enterprise.environmentId, threadId: selection.main },
                });
              }
            }}
          >
            <UsersIcon />
            <span>{(!pinInactive && pinned?.title) || "Main orchestrator"}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {showToday ? (
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/today"} onClick={() => go("/today")}>
              <SunIcon />
              <span>Today</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {showNeeds ? (
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/needs"} onClick={() => go("/needs")}>
              <InboxIcon />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate">Needs you</span>
                {count === null || count === "0" ? null : (
                  <span
                    data-testid="needs-count"
                    className="ml-auto rounded-full bg-primary/10 px-1.5 text-primary text-xs tabular-nums"
                  >
                    {count}
                  </span>
                )}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {showBoard ? (
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/board"} onClick={() => go("/board")}>
              <SquareKanbanIcon />
              <span>Board</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {showMap ? (
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/map"} onClick={() => go("/map")}>
              <MapIcon />
              <span>Map</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {showFeed ? (
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/feed"} onClick={() => go("/feed")}>
              <ActivityIcon />
              <span>Feed</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {showTeam ? (
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/team"} onClick={() => go("/team")}>
              <UsersIcon />
              <span>Team</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
      {feed.sectionsKnown && feed.sections.includes("chat") && (
        <ChannelRows
          key={relayKey(enterprise.target)}
          enterprise={enterprise}
          onOpen={() => {
            if (isMobile) setOpenMobile(false);
          }}
        />
      )}
    </SidebarGroup>
  );
}
