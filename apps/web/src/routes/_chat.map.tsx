import { createFileRoute } from "@tanstack/react-router";

import { MapPage } from "../banneret/MapPage";

export const Route = createFileRoute("/_chat/map")({
  component: MapPage,
});
