// Banneret Hub: the open tabs bar above every page. The root route renders this in place of its
// Outlet. The DOM never changes shape around the Outlet: hiding the bar only flips a data attribute,
// so the page under it is never remounted (ChatView keeps its composer text and scroll).
import "./tabsFrame.css";

import { Outlet, useLocation, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { TabsBar } from "./TabsBar";
import { subscribeTabsToRoute } from "./tabsRoute";
import { useTabsStore } from "./tabsStore";
import { WorkspaceTabsBar } from "./WorkspaceTabsBar";
import { WorkspaceTabsFollower } from "./WorkspaceTabsFollower";
import { useWorkspaceTabsStore } from "./workspaceTabsStore";

export function TabsFrame() {
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hidden = useTabsStore((state) => state.hidden);
  const workspaces = useWorkspaceTabsStore((state) => state.mode === "workspaces");
  const on = !hidden && pathname !== "/welcome";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- every navigation and workspace switch opens or reuses a tab
  useEffect(() => subscribeTabsToRoute(router), [router]);
  return (
    <div data-banneret-tabs-frame={on ? "on" : "off"}>
      <div
        data-banneret-tabs-bar=""
        className={cn("items-center gap-1 border-b bg-background", isElectron && "drag-region")}
      >
        {!on ? null : workspaces ? <WorkspaceTabsBar /> : <TabsBar />}
      </div>
      {workspaces ? <WorkspaceTabsFollower /> : null}
      <div data-banneret-tabs-body="">
        <Outlet />
      </div>
    </div>
  );
}
