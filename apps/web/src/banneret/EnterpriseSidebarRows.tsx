// Banneret Hub: the company rows above the thread list (Today, Needs you with its count, the Board,
// the Map and the Feed), shown only for an Enterprise workspace this machine has joined, and only for sections the
// relay offers. Board, Map and Feed open with the filters last set on them in this window.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ActivityIcon, InboxIcon, MapIcon, SquareKanbanIcon, SunIcon } from "lucide-react";

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
  if (enterprise === null) return null;
  const { feed, workspace } = enterprise;
  const showToday = offersSection(feed, "today");
  const showNeeds = offersSection(feed, "needs");
  const showBoard = offersSection(feed, "board");
  const showMap = offersSection(feed, "map");
  const showFeed = offersSection(feed, "feed");
  if (!showToday && !showNeeds && !showBoard && !showMap && !showFeed) return null;
  const go = (to: "/today" | "/needs" | "/board" | "/map" | "/feed") => {
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
      </SidebarMenu>
    </SidebarGroup>
  );
}
