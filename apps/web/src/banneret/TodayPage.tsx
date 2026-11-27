// Banneret Hub: Today for an Enterprise workspace, drawn from the relay's GET /today. Needs you and
// Stuck on the left, Working now and Shipped on the right, Health tiles below. An empty block
// collapses into one quiet line; a block that is not measured says why.
import type { BanneretFeedNotMeasured } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  HeartPulseIcon,
  InboxIcon,
  type LucideIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { FeedStatus } from "./FeedParts";
import { notMeasuredReason, offersSection } from "./relayFeed.logic";
import { refreshToday } from "./relayFeedStore";
import { blockView, healthSummary, todayCounts, type TodayCounts } from "./today.logic";
import {
  AlarmRow,
  FeedFrame,
  NeedsRow,
  NotMeasuredLines,
  ShippedRow,
  StuckRow,
  WorkingRow,
} from "./TodayRows";
import { readLocalApi } from "../localApi";
import { HealthTile } from "./ui/HealthTile";
import { PageHeader, SummaryFigure } from "./ui/PageHeader";
import { QuietLine } from "./ui/QuietLine";
import { RelativeTime } from "./ui/RelativeTime";
import { Section } from "./ui/Section";
import { humanizeWord } from "./ui/status";
import { LAYOUT_HEALTH_TILES, LAYOUT_TODAY_COLUMNS, TYPE } from "./ui/tokens";
import { useEnterpriseFeed } from "./useEnterpriseFeed";

/** The Feed page's frame. Today and Needs you use `FeedFrame`. */
export function FeedPage(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <SidebarInset role="main" className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <h1 className="font-medium text-sm">{props.title}</h1>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer className="gap-4">{props.children}</WorkspacePageContainer>
      </ScrollArea>
    </SidebarInset>
  );
}

export function NotJoinedNote() {
  return (
    <p className="text-muted-foreground text-sm">
      Choose an Enterprise workspace that this machine has joined to see its company here.
    </p>
  );
}

/** "2 need you · 3 stuck · 4 shipped since your last visit". */
function Summary(props: { readonly counts: TodayCounts }) {
  const { needs, stuck, shipped, sinceVisit } = props.counts;
  return (
    <>
      <SummaryFigure>
        {needs} {needs === "1" ? "needs" : "need"} you
      </SummaryFigure>
      {` · ${stuck} stuck · ${shipped} shipped`}
      {sinceVisit ? " since your last visit" : null}
    </>
  );
}

/**
 * One Today block: its rows in a section, or a quiet line. Not measured is never shown as empty:
 * the line names each source and why.
 */
function Block(props: {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly items: ReadonlyArray<unknown>;
  readonly notMeasured: ReadonlyArray<BanneretFeedNotMeasured>;
  readonly empty: { readonly fact: string; readonly hint: string };
  readonly attention?: boolean;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const view = blockView(props);
  if (view === "empty") {
    return <QuietLine icon={props.icon} fact={props.empty.fact} hint={props.empty.hint} />;
  }
  if (view === "not_measured") {
    return (
      <QuietLine
        icon={props.icon}
        fact={`${props.title} is not measured.`}
        hint={<NotMeasuredLines lines={props.notMeasured} />}
      />
    );
  }
  return (
    <Section
      title={props.title}
      icon={props.icon}
      count={props.items.length}
      attention={props.attention ?? false}
      action={props.action}
    >
      {props.children}
      {props.notMeasured.length === 0 ? null : (
        <p className={`${TYPE.meta} px-2.5 pt-1 pb-2`}>
          <NotMeasuredLines lines={props.notMeasured} />
        </p>
      )}
    </Section>
  );
}

function RefreshButton(props: { readonly target: Parameters<typeof refreshToday>[0] }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        // Not a visit: only opening Today moves "since your last visit".
        void refreshToday(props.target, false).finally(() => setBusy(false));
      }}
    >
      <RefreshCwIcon aria-hidden />
      Refresh
    </Button>
  );
}

export function TodayPage() {
  const enterprise = useEnterpriseFeed();
  const environmentId = enterprise?.environmentId ?? null;
  const relayOrigin = enterprise?.target.relayOrigin ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening Today (of this workspace's company) is the one read that counts as a visit
  useEffect(() => {
    if (environmentId !== null && relayOrigin !== null) {
      void refreshToday({ environmentId, relayOrigin }, true);
    }
  }, [environmentId, relayOrigin]);

  if (enterprise === null) {
    return (
      <FeedFrame title="Today">
        <PageHeader title="Today" />
        <QuietLine
          fact="No company here yet."
          hint="Choose an Enterprise workspace that this machine has joined to see its company here."
        />
      </FeedFrame>
    );
  }
  const { feed, workspace } = enterprise;
  const today = feed.today;
  if (!offersSection(feed, "today")) {
    return (
      <FeedFrame title="Today" company={workspace.name}>
        <PageHeader title="Today" />
        <QuietLine fact={`${workspace.name} does not offer Today.`} />
      </FeedFrame>
    );
  }

  let body: ReactNode = null;
  if (today === null) {
    if (feed.todayProblem === null && !feed.unreachable) body = <QuietLine fact="Loading…" />;
  } else {
    const health = feed.sections.includes("health") ? today.health : undefined;
    const healthTiles = !health
      ? []
      : [
          ...health.alarms.map((alarm) => (
            <AlarmRow key={JSON.stringify([alarm.sourceId, alarm.id])} alarm={alarm} />
          )),
          ...health.items.map((item) => (
            <li key={JSON.stringify(["item", item.source, item.id])} className="min-w-0">
              <HealthTile
                label={item.label}
                source={item.source}
                kind={item.kind}
                state={item.state}
                summary={item.summary}
                observedAt={item.observedAt}
              />
            </li>
          )),
          ...health.notMeasured.map((line) => (
            <li key={`nm:${line.source}:${line.since}`} className="min-w-0" data-not-measured="">
              <HealthTile
                label={humanizeWord(line.source)}
                {...(line.kind ? { source: line.source, kind: line.kind } : {})}
                state="not_measured"
                summary={line.detail ?? `${humanizeWord(notMeasuredReason(line.reason))}.`}
                observedAt={line.since}
                timePrefix="Off"
                timeKind="duration"
              />
            </li>
          )),
        ];
    body = (
      <>
        <div {...LAYOUT_TODAY_COLUMNS}>
          <div>
            <Block
              title="Needs you"
              icon={InboxIcon}
              items={today.needsYou.items}
              notMeasured={today.needsYou.notMeasured}
              empty={{
                fact: "Nobody needs you right now.",
                hint: "Questions, reviews and approvals show here.",
              }}
              action={
                offersSection(feed, "needs") ? (
                  <Link to="/needs" className="text-muted-foreground text-xs hover:text-foreground">
                    See all
                  </Link>
                ) : undefined
              }
            >
              <ul aria-label="Needs you items">
                {today.needsYou.items.map((item) => (
                  <NeedsRow key={item.id} item={item} />
                ))}
              </ul>
            </Block>
            <Block
              title="Stuck"
              icon={TriangleAlertIcon}
              attention
              items={today.stuck.items}
              notMeasured={today.stuck.notMeasured}
              empty={{
                fact: "Nothing is stuck.",
                hint: "Failing checks, red branches and quiet claims show here.",
              }}
            >
              <ul aria-label="Stuck items">
                {today.stuck.items.map((item) => (
                  <StuckRow
                    key={`${item.rules.join(",")}:${item.since}:${item.task?.title ?? item.subject?.repo ?? ""}:${item.subject?.job?.name ?? ""}:${item.subject?.run?.name ?? ""}`}
                    item={item}
                  />
                ))}
              </ul>
            </Block>
          </div>
          <div>
            <Block
              title="Working now"
              icon={ActivityIcon}
              items={today.working.items}
              notMeasured={today.working.notMeasured}
              empty={{
                fact: "Nobody is working right now.",
                hint: "People and their agents show here while they work.",
              }}
            >
              <ul aria-label="Working now items">
                {today.working.items.map((item) => (
                  <WorkingRow
                    key={`${item.person.login}:${item.task?.title ?? ""}:${item.branch ?? ""}`}
                    item={item}
                  />
                ))}
              </ul>
            </Block>
            <Block
              title="Shipped"
              icon={PullRequestGlyph.merged}
              items={today.shipped.items}
              notMeasured={today.shipped.notMeasured}
              empty={
                today.lastVisitAt === null
                  ? { fact: "Nothing shipped yet.", hint: "Merged pull requests show here." }
                  : {
                      fact: "Nothing shipped since your last visit.",
                      hint: "Merged pull requests show here.",
                    }
              }
              action={
                today.lastVisitAt === null ? undefined : (
                  <RelativeTime
                    at={today.lastVisitAt}
                    prefix="last visit"
                    className={cn(TYPE.meta, "whitespace-nowrap")}
                  />
                )
              }
            >
              <ul aria-label="Shipped items">
                {today.shipped.items.map((item) => (
                  <ShippedRow key={`${item.pr.url}:${item.mergedAt}`} item={item} />
                ))}
              </ul>
            </Block>
          </div>
        </div>
        {!health ? null : healthTiles.length === 0 ? (
          <QuietLine
            icon={HeartPulseIcon}
            fact="Health has nothing to show yet."
            hint="Checks this relay runs show here as tiles."
          />
        ) : (
          <Section
            title="Health"
            icon={HeartPulseIcon}
            count={healthTiles.length}
            action={
              healthSummary(health.items) === null ? undefined : (
                <span className={TYPE.meta}>{healthSummary(health.items)}</span>
              )
            }
          >
            <ul aria-label="Health" {...LAYOUT_HEALTH_TILES}>
              {healthTiles}
            </ul>
          </Section>
        )}
      </>
    );
  }

  return (
    <FeedFrame title="Today" company={workspace.name}>
      <PageHeader
        title="Today"
        summary={today === null ? undefined : <Summary counts={todayCounts(today, feed)} />}
      >
        <RefreshButton target={enterprise.target} />
      </PageHeader>
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={feed.todayFetchedAt}
        problem={feed.todayProblem}
      />
      {feed.dashboards?.length ? (
        <nav aria-label="Dashboards" className="flex flex-wrap gap-3">
          {feed.dashboards.map((d) => (
            <button
              type="button"
              className="text-sm hover:underline"
              key={d.id}
              onClick={() =>
                void readLocalApi()
                  ?.shell.openExternal(d.url)
                  .catch(() => undefined)
              }
            >
              {d.group ? d.group + " / " : ""}
              {d.title}
            </button>
          ))}
        </nav>
      ) : null}
      {body}
    </FeedFrame>
  );
}
