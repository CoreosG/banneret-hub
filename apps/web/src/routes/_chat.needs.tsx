import { createFileRoute } from "@tanstack/react-router";

import { NeedsPage } from "../banneret/NeedsPage";

export const Route = createFileRoute("/_chat/needs")({
  component: NeedsPage,
});
