// Banneret Hub: Needs you for an Enterprise workspace, from the relay's GET /needs in the order the
// relay returns it (most urgent first). Pages load on request.
import { InboxIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { FeedStatus } from "./FeedParts";
import { offersSection } from "./relayFeed.logic";
import { loadMoreNeeds } from "./relayFeedStore";
import { FeedFrame, NeedsRow } from "./TodayRows";
import { PageHeader, SummaryFigure } from "./ui/PageHeader";
import { QuietLine } from "./ui/QuietLine";
import { Section, SectionEmpty } from "./ui/Section";
import { useEnterpriseFeed } from "./useEnterpriseFeed";

export function NeedsPage() {
  const enterprise = useEnterpriseFeed();
  const [loading, setLoading] = useState(false);
  if (enterprise === null) {
    return (
      <FeedFrame title="Needs you">
        <PageHeader title="Needs you" />
        <QuietLine
          fact="No company here yet."
          hint="Choose an Enterprise workspace that this machine has joined to see its company here."
        />
      </FeedFrame>
    );
  }
  const { feed, workspace, environmentId } = enterprise;
  if (!offersSection(feed, "needs")) {
    return (
      <FeedFrame title="Needs you" company={workspace.name}>
        <PageHeader title="Needs you" />
        <QuietLine fact={`${workspace.name} does not offer Needs you.`} />
      </FeedFrame>
    );
  }
  const items = feed.needs;
  const count = feed.needsCount ?? items?.length ?? null;
  return (
    <FeedFrame title="Needs you" company={workspace.name}>
      <PageHeader
        title="Needs you"
        summary={
          count === null || count === 0 ? undefined : (
            <>
              <SummaryFigure>
                {count} {count === 1 ? "item" : "items"}
              </SummaryFigure>
              {" waiting on you, most urgent first"}
            </>
          )
        }
      />
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={feed.needsFetchedAt}
        problem={feed.needsProblem}
      />
      {items === null ? (
        feed.needsProblem === null && !feed.unreachable ? (
          <QuietLine fact="Loading…" />
        ) : null
      ) : (
        <Section title="Needs you" icon={InboxIcon} count={items.length}>
          {items.length === 0 ? (
            <SectionEmpty
              icon={InboxIcon}
              title="Nobody needs you right now."
              description="Questions, reviews and approvals that wait on you show here."
            />
          ) : (
            <ul aria-label="Needs you items">
              {items.map((item) => (
                <NeedsRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </Section>
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
    </FeedFrame>
  );
}
