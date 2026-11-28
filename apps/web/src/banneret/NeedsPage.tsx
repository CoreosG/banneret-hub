import { WorkflowNeeds } from "./WorkflowReview";
import { WaitingAsks } from "./chat/AgentAskCards";
import { HandoffCards } from "./chat/HandoffCards";
import { JoinRequests } from "./chat/JoinRequests";
// Banneret Hub: Needs you for an Enterprise workspace, from the relay's GET /needs in the order the
// relay returns it (most urgent first). Pages load on request.
import { LocalCallApprovals } from "./CallApprovals";
import { InboxIcon } from "lucide-react";
import { useState } from "react";

import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Button } from "../components/ui/button";
import { FeedStatus } from "./FeedParts";
import { offersSection } from "./relayFeed.logic";
import { loadMoreNeeds } from "./relayFeedStore";
import { needsFigure } from "./today.logic";
import { FeedFrame, NeedsRow } from "./TodayRows";
import { PageHeader, SummaryFigure } from "./ui/PageHeader";
import { QuietLine } from "./ui/QuietLine";
import { Section, SectionEmpty } from "./ui/Section";
import { useEnterpriseFeed } from "./useEnterpriseFeed";

const groups = {
  Questions: ["agent_ask", "chat_ask", "thread_question", "founder_question", "persona_ask"],
  Mentions: ["mention", "agent_message"],
  Reviews: [
    "review_request",
    "chat_join_requests",
    "thread_approval",
    "pr_approval",
    "waiting_for_approver",
    "pull_request",
    "promotion",
  ],
};
const filters = ["All", "Questions", "Mentions", "Reviews"] as const;
export function NeedsPage() {
  const [filter, setFilter] = useState<(typeof filters)[number]>("All");
  const enterprise = useEnterpriseFeed();
  const [loading, setLoading] = useState(false);
  if (enterprise === null) {
    return (
      <FeedFrame title="Needs you">
        <PageHeader title="Needs you" />
        <>
          <WorkflowNeeds />
          <LocalCallApprovals />
        </>
        <QuietLine
          fact="No company here yet."
          hint="Choose an Enterprise workspace that this machine has joined to see its company here."
        />
      </FeedFrame>
    );
  }
  const { feed, workspace, target } = enterprise;
  if (!offersSection(feed, "needs")) {
    return (
      <FeedFrame title="Needs you" company={workspace.name}>
        <PageHeader title="Needs you" />
        <>
          <WorkflowNeeds />
          <LocalCallApprovals />
        </>
        <QuietLine fact={`${workspace.name} does not offer Needs you.`} />
      </FeedFrame>
    );
  }
  const items =
    filter === "All"
      ? feed.needs
      : (feed.needs?.filter((i) => groups[filter].includes(i.kind)) ?? null);
  const count = items === null && feed.needsCount === null ? null : needsFigure(feed, null);
  return (
    <FeedFrame title="Needs you" company={workspace.name}>
      <PageHeader
        title="Needs you"
        summary={
          count === null || count === "0" ? undefined : (
            <>
              <SummaryFigure>
                {count} {count === "1" ? "item" : "items"}
              </SummaryFigure>
              {" listed, most urgent first"}
            </>
          )
        }
      />
      {(filter === "All" || filter === "Reviews") && (
        <>
          <WorkflowNeeds />
          <LocalCallApprovals />
        </>
      )}
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={feed.needsFetchedAt}
        problem={feed.needsProblem}
      />
      <ToggleGroup
        aria-label="Needs you filters"
        value={[filter]}
        onValueChange={(values) => {
          const next = filters.find((f) => f === values[0]);
          if (next) setFilter(next);
        }}
      >
        {filters.map((f) => (
          <Toggle key={f} value={f}>
            {f}
          </Toggle>
        ))}
      </ToggleGroup>
      {items === null ? (
        feed.needsProblem === null && !feed.unreachable ? (
          <QuietLine fact="Loading…" />
        ) : null
      ) : (
        <Section title="Needs you" icon={InboxIcon} count={items.length}>
          {items.length === 0 ? (
            <SectionEmpty
              icon={InboxIcon}
              title={
                filter === "All"
                  ? "Nobody needs you right now."
                  : "No " + filter.toLowerCase() + " in this list."
              }
              description="Questions, reviews and approvals that wait on you show here."
            />
          ) : (
            <ul aria-label="Needs you items">
              {items.map((item) =>
                (item.kind === "review_request" || item.kind === "agent_ask") &&
                feed.chatFlags?.includes("agent_asks") ? (
                  <WaitingAsks
                    key={item.id}
                    item={item}
                    target={target}
                    chatRevision={feed.chatRevision}
                  />
                ) : item.handoffId && feed.chatFlags?.includes("handoffs") ? (
                  <li key={item.id}>
                    <HandoffCards enterprise={enterprise} id={item.handoffId} />
                  </li>
                ) : item.kind === "chat_join_requests" &&
                  item.conversationId &&
                  feed.chatFlags?.includes("join_requests") ? (
                  <JoinRequests
                    key={item.id}
                    item={item}
                    target={target}
                    people={feed.team?.value?.people}
                    revision={feed.chatRevision}
                  />
                ) : (
                  <NeedsRow
                    asks={feed.chatFlags?.includes("asks")}
                    key={item.id}
                    item={item}
                    target={target}
                  />
                ),
              )}
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
              void loadMoreNeeds(target).finally(() => setLoading(false));
            }}
          >
            Load more
          </Button>
        </div>
      )}
    </FeedFrame>
  );
}
