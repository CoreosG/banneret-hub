import { createFileRoute } from "@tanstack/react-router";
import { ChannelPage } from "../banneret/chat/ChannelPage";
export const Route = createFileRoute("/_chat/channels/$channelId")({
  validateSearch: (search: Record<string, unknown>) => ({
    thread: typeof search.thread === "string" ? search.thread : undefined,
  }),
  component: ChannelRoute,
});
function ChannelRoute() {
  const { channelId } = Route.useParams();
  const { thread } = Route.useSearch();
  return <ChannelPage id={channelId} root={thread} />;
}
