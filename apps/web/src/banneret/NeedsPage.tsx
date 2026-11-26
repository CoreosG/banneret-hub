// Banneret Hub: Needs you for an Enterprise workspace, from the relay's GET /needs in the order the
// relay returns it (most urgent first). Pages load on request.
import { useState } from "react";

import { Button } from "../components/ui/button";
import { FeedStatus, NeedsItemRow } from "./FeedParts";
import { offersSection } from "./relayFeed.logic";
import { loadMoreNeeds } from "./relayFeedStore";
import { FeedPage, NotJoinedNote } from "./TodayPage";
import { useEnterpriseFeed } from "./useEnterpriseFeed";

export function NeedsPage() {
  const enterprise = useEnterpriseFeed();
  const [loading, setLoading] = useState(false);
  if (enterprise === null) {
    return (
      <FeedPage title="Needs you">
        <NotJoinedNote />
      </FeedPage>
    );
  }
  const { feed, workspace, environmentId } = enterprise;
  if (!offersSection(feed, "needs")) {
    return (
      <FeedPage title="Needs you">
        <p className="text-muted-foreground text-sm">{workspace.name} does not offer Needs you.</p>
      </FeedPage>
    );
  }
  const items = feed.needs;
  return (
    <FeedPage title={`Needs you in ${workspace.name}`}>
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={feed.needsFetchedAt}
        problem={feed.needsProblem}
      />
      {items === null ? (
        feed.needsProblem === null && !feed.unreachable ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : null
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing needs you.</p>
      ) : (
        <ul aria-label="Needs you items" className="divide-y rounded-lg border px-4">
          {items.map((item) => (
            <NeedsItemRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      {feed.needsNextCursor === null ? null : (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              void loadMoreNeeds(environmentId).finally(() => setLoading(false));
            }}
          >
            Load more
          </Button>
        </div>
      )}
    </FeedPage>
  );
}
