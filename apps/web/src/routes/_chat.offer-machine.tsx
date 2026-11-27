import { createFileRoute } from "@tanstack/react-router";

import { PoolFounderPage } from "../banneret/PoolFounderPage";

export const Route = createFileRoute("/_chat/offer-machine")({
  component: PoolFounderPage,
});
