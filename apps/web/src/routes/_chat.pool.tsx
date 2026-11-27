import { createFileRoute } from "@tanstack/react-router";

import { PoolPage } from "../banneret/PoolPage";

export const Route = createFileRoute("/_chat/pool")({
  validateSearch: (search: Record<string, unknown>): { taskId?: string } =>
    typeof search.taskId === "string" ? { taskId: search.taskId } : {},
  component: function PoolRoute() {
    return <PoolPage taskId={Route.useSearch().taskId} />;
  },
});
