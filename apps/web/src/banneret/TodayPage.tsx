// Banneret Hub: Today for an Enterprise workspace, drawn from the relay's GET /today. The five blocks
// come in the relay's order (J1): needs you, shipped since the last visit, working now, stuck, health.
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Age, FeedSection, FeedStatus, NeedsItemRow, OpenTarget, When } from "./FeedParts";
import {
  healthStateLabel,
  healthTone,
  offersSection,
  safeLinkOut,
  shippedLabel,
  shippedRefLabel,
  stuckRulesLabel,
  stuckSubject,
  type StuckSubjectRef,
  type Tone,
  workingStateLabel,
} from "./relayFeed.logic";
import { refreshToday } from "./relayFeedStore";
import { loginOrUnknown, loginSuffix } from "./enterprise.logic";
import { useEnterpriseFeed } from "./useEnterpriseFeed";

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

function TaskTitle(props: {
  readonly task: { readonly title: string; readonly url?: string | undefined };
}) {
  const href = safeLinkOut(props.task.url);
  return href === null ? (
    <span className="break-words">{props.task.title}</span>
  ) : (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-words hover:underline"
    >
      {props.task.title}
    </a>
  );
}

/** "repo · #41 · ", linked to the pull request; nothing when its link names neither. */
function ShippedRef(props: { readonly url: string | undefined }) {
  const label = shippedRefLabel(props.url);
  if (label === null) return null;
  const href = safeLinkOut(props.url);
  return (
    <>
      {href === null ? (
        <span>{label}</span>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
          {label}
        </a>
      )}
      {" \u00b7 "}
    </>
  );
}

function StuckSubjectView(props: {
  readonly task: { readonly title: string; readonly url?: string | undefined } | undefined;
  readonly subject?: StuckSubjectRef | undefined;
}) {
  const subject = stuckSubject(props.task, props.subject);
  return subject.kind === "task" ? (
    <TaskTitle task={subject} />
  ) : (
    <span className="text-muted-foreground" data-stuck-subject="none">
      no task or pull request named
    </span>
  );
}

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

export function TodayPage() {
  const enterprise = useEnterpriseFeed();
  const environmentId = enterprise?.environmentId ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening Today is the one read that counts as a visit
  useEffect(() => {
    if (environmentId !== null) void refreshToday(environmentId, true);
  }, [environmentId]);

  if (enterprise === null) {
    return (
      <FeedPage title="Today">
        <NotJoinedNote />
      </FeedPage>
    );
  }
  const { feed, workspace } = enterprise;
  const today = feed.today;
  if (!offersSection(feed, "today")) {
    return (
      <FeedPage title="Today">
        <p className="text-muted-foreground text-sm">{workspace.name} does not offer Today.</p>
      </FeedPage>
    );
  }
  return (
    <FeedPage title={`Today in ${workspace.name}`}>
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={feed.todayFetchedAt}
        problem={feed.todayProblem}
      />
      {today === null ? (
        feed.todayProblem === null && !feed.unreachable ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : null
      ) : (
        <>
          <FeedSection
            title="Needs you"
            empty={today.needsYou.items.length === 0}
            notMeasured={today.needsYou.notMeasured}
            action={
              offersSection(feed, "needs") ? (
                <Link to="/needs" className="text-primary text-xs hover:underline">
                  See all
                </Link>
              ) : null
            }
          >
            <ul className="divide-y">
              {today.needsYou.items.map((item) => (
                <NeedsItemRow key={item.id} item={item} />
              ))}
            </ul>
          </FeedSection>

          <FeedSection
            title={
              today.lastVisitAt === null ? (
                "Shipped"
              ) : (
                <>
                  Shipped since your last visit (<When at={today.lastVisitAt} />)
                </>
              )
            }
            empty={today.shipped.items.length === 0}
            notMeasured={today.shipped.notMeasured}
          >
            <ul className="flex flex-col gap-1.5 text-sm">
              {today.shipped.items.map((item) => (
                <li key={`${item.task.title}:${item.mergedAt}`} className="flex flex-col">
                  <span className="break-words">{item.summary}</span>
                  <span className="text-muted-foreground text-xs">
                    <ShippedRef url={item.task.url} />
                    {shippedLabel(item.live)} · <Age at={item.mergedAt} />
                  </span>
                </li>
              ))}
            </ul>
          </FeedSection>

          <FeedSection
            title="Working now"
            empty={today.working.items.length === 0}
            notMeasured={today.working.notMeasured}
          >
            <ul className="flex flex-col gap-1.5 text-sm">
              {today.working.items.map((item) => {
                const state = workingStateLabel(item.state);
                return (
                  <li
                    key={`${item.person.login}:${item.task?.title ?? ""}:${item.branch ?? ""}`}
                    className="flex items-start gap-3"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="break-words">
                        {loginOrUnknown(item.person.login)}
                        {item.task === undefined ? null : (
                          <>
                            {" on "}
                            <TaskTitle task={item.task} />
                          </>
                        )}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {item.state === "not_heard_from" ? (
                          <>
                            not heard from since <When at={item.lastActivityAt} />
                          </>
                        ) : (
                          <>
                            {state === null ? null : `${state} · `}
                            last activity <Age at={item.lastActivityAt} />
                          </>
                        )}
                        {item.branch === undefined ? null : ` · ${item.branch}`}
                        {item.sessions === undefined
                          ? null
                          : ` · ${item.sessions} ${item.sessions === 1 ? "session" : "sessions"}`}
                      </span>
                    </div>
                    <OpenTarget deepLink={item.deepLink} />
                  </li>
                );
              })}
            </ul>
          </FeedSection>

          <FeedSection
            title="Stuck"
            empty={today.stuck.items.length === 0}
            notMeasured={today.stuck.notMeasured}
          >
            <ul className="flex flex-col gap-1.5 text-sm">
              {today.stuck.items.map((item) => (
                <li
                  key={`${item.rules.join(",")}:${item.since}:${item.task?.title ?? item.subject?.repo ?? ""}:${item.subject?.run?.name ?? ""}`}
                  className="flex items-start gap-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="break-words">
                      {stuckRulesLabel(item.rules)}
                      {": "}
                      <StuckSubjectView task={item.task} subject={item.subject} />
                    </span>
                    <span className="text-muted-foreground text-xs">
                      since <When at={item.since} />
                      {item.owner === undefined
                        ? null
                        : loginSuffix("claimed by", item.owner.login)}
                    </span>
                  </div>
                  <OpenTarget deepLink={item.deepLink} />
                </li>
              ))}
            </ul>
          </FeedSection>

          <FeedSection
            title="Health"
            empty={today.health.items.length === 0}
            notMeasured={today.health.notMeasured}
          >
            <ul className="flex flex-col gap-1.5 text-sm">
              {today.health.items.map((item) => (
                <li key={item.id} className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      TONE_DOT[healthTone(item.state)],
                    )}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="break-words">
                      {item.label}: {healthStateLabel(item.state)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {item.summary === undefined ? null : `${item.summary} · `}
                      {item.observedAt === null ? (
                        "not checked yet"
                      ) : (
                        <Age at={item.observedAt} prefix="checked" />
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </FeedSection>
        </>
      )}
    </FeedPage>
  );
}
