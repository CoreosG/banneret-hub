import { createFileRoute } from "@tanstack/react-router";

import { TodayPage } from "../banneret/TodayPage";

export const Route = createFileRoute("/_chat/today")({
  component: TodayPage,
});
