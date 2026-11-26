// Banneret Hub: the company rows above the thread list (Today, and Needs you with its count), shown
// only for an Enterprise workspace this machine has joined, and only for sections the relay offers.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { InboxIcon, SunIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { needsCountLabel } from "./relayFeed.logic";
import { useEnterpriseFeed } from "./useEnterpriseFeed";

export function EnterpriseSidebarRows() {
  const enterprise = useEnterpriseFeed();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (enterprise === null) return null;
  const { feed, workspace } = enterprise;
  const showToday = feed.sections.includes("today");
  const showNeeds = feed.sections.includes("needs");
  if (!showToday && !showNeeds) return null;
  const go = (to: "/today" | "/needs") => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to });
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
      </SidebarMenu>
    </SidebarGroup>
  );
}
