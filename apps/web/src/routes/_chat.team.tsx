import { createFileRoute } from "@tanstack/react-router";

import { TeamPage } from "../banneret/TeamPage";

export const Route = createFileRoute("/_chat/team")({
  component: TeamPage,
});
