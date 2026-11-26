import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../banneret/BoardPage";

export const Route = createFileRoute("/_chat/board")({
  component: BoardPage,
});
