import { createFileRoute } from "@tanstack/react-router";

import { FeedActivityPage } from "../banneret/FeedActivityPage";

export const Route = createFileRoute("/_chat/feed")({
  component: FeedActivityPage,
});
