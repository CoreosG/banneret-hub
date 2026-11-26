// Banneret Hub: the open tabs bar above every page. The root route renders this in place of its
// Outlet. The DOM never changes shape around the Outlet: hiding the bar only flips a data attribute,
// so the page under it is never remounted (ChatView keeps its composer text and scroll).
import "./tabsFrame.css";

import { Outlet, useLocation } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";

export function TabsFrame() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const on = pathname !== "/welcome";
  return (
    <div data-banneret-tabs-frame={on ? "on" : "off"}>
      <div
        data-banneret-tabs-bar=""
        className={cn("items-center gap-1 border-b bg-background", isElectron && "drag-region")}
      />
      <div data-banneret-tabs-body="">
        <Outlet />
      </div>
    </div>
  );
}
