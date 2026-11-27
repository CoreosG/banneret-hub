import { createFileRoute } from "@tanstack/react-router";

import { PoolPage } from "../banneret/PoolPage";

export const Route = createFileRoute("/_chat/pool")({
  component: PoolPage,
});
