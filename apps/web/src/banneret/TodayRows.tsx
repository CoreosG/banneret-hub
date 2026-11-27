// Banneret Hub: the rows Today and Needs you draw, on the fork UI kit. Every relay string renders as
// plain text; links out are http(s) only.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type BanneretFeedDeepLink,
  type BanneretFeedNeedsItem,
  type BanneretFeedNotMeasured,
  type BanneretFeedToday,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AtSignIcon,
  BotIcon,
  CircleDotIcon,
  CircleHelpIcon,
  ExternalLinkIcon,
  HeartPulseIcon,
  LightbulbIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  RocketIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from "lucide-react";
import { chatHref } from "./chat/ChannelRows";
import { chatRpc } from "./chat/client";
import type { RelayTarget } from "./enrolmentStore";
import { useState, type ReactNode } from "react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { loginOrUnknown, loginSuffix } from "./enterprise.logic";
import {
  deepLinkTarget,
  needsKindLabel,
  notMeasuredReason,
  safeLinkOut,
  shippedLabel,
  shippedRefLabel,
  stuckSubject,
  taskRefLabel,
  workingStateLabel,
} from "./relayFeed.logic";
import { initial, workingTone } from "./today.logic";
import { ReasonChip } from "./ui/Chips";
import { StatusPill } from "./ui/StatusPill";
import { RelativeTime } from "./ui/RelativeTime";
import { SectionRow } from "./ui/Section";
import { humanizeWord } from "./ui/status";
import { LAYOUT_PAGE, TYPE, toneProps } from "./ui/tokens";

type ShippedItem = BanneretFeedToday["shipped"]["items"][number];
type WorkingItem = BanneretFeedToday["working"]["items"][number];
type StuckItem = BanneretFeedToday["stuck"]["items"][number];

/** A readable page under the workspace header that names the company; the page scrolls. */
export function FeedFrame(props: {
  readonly title: string;
  readonly company?: string;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset role="main" className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          {props.company === undefined ? null : (
            <>
              <span className="truncate text-muted-foreground">{props.company}</span>
              <span aria-hidden className="text-muted-foreground">
                /
              </span>
            </>
          )}
          <span className="font-medium">{props.title}</span>
        </span>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full flex-col gap-4 px-6 pt-6 pb-8" {...LAYOUT_PAGE}>
          {props.children}
        </div>
      </ScrollArea>
    </SidebarInset>
  );
}

const OPEN_LOOK =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-card px-2 font-medium text-xs hover:bg-accent";

/** Where an item opens: its thread here, its link out, or a note naming the machine that holds it. */
function OpenTarget(props: {
  readonly deepLink: BanneretFeedDeepLink | undefined;
  readonly url?: string | undefined;
}) {
  const navigate = useNavigate();
  const environmentId =
    props.deepLink === undefined ? null : EnvironmentId.make(props.deepLink.environmentId);
  const environment = useEnvironment(environmentId);
  const threadId = props.deepLink?.threadId;
  const thread = useThreadShell(
    environmentId === null || threadId === undefined
      ? null
      : scopeThreadRef(environmentId, ThreadId.make(threadId)),
  );
  const target = deepLinkTarget({
    deepLink: props.deepLink,
    url: props.url,
    environmentKnown: environment !== null,
    threadKnown: thread !== null,
  });
  switch (target.kind) {
    case "thread":
      return (
        <button
          type="button"
          className={OPEN_LOOK}
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: target.environmentId, threadId: target.threadId },
            })
          }
        >
          <MessageSquareIcon className="size-3.5 text-muted-foreground" aria-hidden />
          Open thread
        </button>
      );
    case "link":
      return (
        <a href={target.url} target="_blank" rel="noopener noreferrer" className={OPEN_LOOK}>
          <ExternalLinkIcon className="size-3.5 text-muted-foreground" aria-hidden />
          Open
        </a>
      );
    case "elsewhere":
      return <span className={cn(TYPE.meta, "shrink-0")}>on {target.machine}</span>;
    case "none":
      return null;
  }
}

/** A title that links out when it has an http(s) link. */
function TitleLink(props: { readonly title: string; readonly url: string | undefined }) {
  const href = safeLinkOut(props.url);
  return href === null ? (
    <>{props.title}</>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
      {props.title}
    </a>
  );
}

const NEEDS_ICONS: Readonly<Record<string, LucideIcon>> = {
  chat_ask: MessageCircleQuestionIcon,
  thread_question: MessageCircleQuestionIcon,
  thread_approval: ShieldCheckIcon,
  pull_request: PullRequestGlyph.pullRequest,
  promotion: RocketIcon,
  founder_question: CircleHelpIcon,
  health: HeartPulseIcon,
  mention: AtSignIcon,
  agent_message: BotIcon,
  persona_ask: UserRoundIcon,
  suggestion: LightbulbIcon,
};

/** One thing that needs the person: kind icon, the subject, who asks and when, and where it opens. */
export function NeedsRow(props: { readonly item: BanneretFeedNeedsItem; target: RelayTarget }) {
  const { item } = props;
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const read = item.chatRead;
  const Icon = NEEDS_ICONS[item.kind] ?? CircleDotIcon;
  return (
    <li data-kind={item.kind} className="min-w-0">
      <SectionRow className="items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border bg-card"
        >
          <Icon className="size-3.5 text-muted-foreground" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn(TYPE.cardTitle, "break-words")}>{item.title}</span>
          <span className={TYPE.meta}>
            {read && item.kind === "agent_message" ? "Direct message" : needsKindLabel(item.kind)}
            {item.from === undefined ? null : loginSuffix("from", item.from.login)}
            {" · "}
            <RelativeTime at={item.createdAt} />
          </span>
          {item.recommendation === undefined ? null : (
            <span className={cn(TYPE.meta, "break-words")}>Recommended: {item.recommendation}</span>
          )}
        </div>
        {read ? (
          <>
            <button
              className={OPEN_LOOK}
              onClick={() =>
                void navigate({ href: chatHref(read.conversationId, read.threadRootId) })
              }
            >
              Open conversation
            </button>
            <button
              className={OPEN_LOOK}
              onClick={() =>
                void chatRpc
                  .run(props.target, { kind: "read", read })
                  .catch((e) => setError(String(e)))
              }
            >
              Mark read
            </button>
            {error && <span role="alert">{error}</span>}
          </>
        ) : (
          <OpenTarget deepLink={item.deepLink} url={item.url} />
        )}
      </SectionRow>
    </li>
  );
}

/** One stuck item: what it is about, every reason as a chip in the relay's order, and since when. */
export function StuckRow(props: { readonly item: StuckItem }) {
  const { item } = props;
  const subject = stuckSubject(item.task, item.subject);
  const ref =
    item.task !== undefined && item.task.title.trim() !== "" ? taskRefLabel(item.task.url) : null;
  return (
    <li className="min-w-0">
      <SectionRow className="items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {subject.kind === "task" ? (
            <span className={cn(TYPE.cardTitle, "break-words")} data-slot="stuck-subject">
              <TitleLink title={subject.title} url={subject.url} />
            </span>
          ) : (
            <span className="text-muted-foreground text-sm" data-stuck-subject="none">
              No task or pull request named
            </span>
          )}
          <span className="flex flex-wrap items-center gap-1.5">
            {item.rules.map((rule) => (
              <ReasonChip key={rule} reason={rule} />
            ))}
            <span className={TYPE.meta}>
              <RelativeTime at={item.since} prefix="stuck" kind="duration" />
              {item.owner === undefined ? null : loginSuffix("claimed by", item.owner.login)}
            </span>
          </span>
        </div>
        {ref === null ? null : <span className={cn(TYPE.ref, "mt-0.5 shrink-0")}>{ref}</span>}
        <OpenTarget deepLink={item.deepLink} />
      </SectionRow>
    </li>
  );
}

/** One person at work: who, on what, in what state; the avatar is ringed while an agent works. */
export function WorkingRow(props: { readonly item: WorkingItem }) {
  const { item } = props;
  const login = loginOrUnknown(item.person.login);
  const state = workingStateLabel(item.state);
  const atWork = item.state === "working";
  const title =
    item.task !== undefined && item.task.title.trim() !== ""
      ? item.task.title
      : (item.branch ?? "No task named");
  return (
    <li className="min-w-0" data-at-work={atWork ? "" : undefined}>
      <SectionRow className="gap-3">
        <span
          aria-hidden
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border bg-accent font-semibold text-2xs",
            atWork && "ring-2 ring-primary ring-offset-2 ring-offset-card",
          )}
        >
          {initial(login)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn(TYPE.cardTitle, "truncate")}>
            {item.task === undefined ? title : <TitleLink title={title} url={item.task.url} />}
          </span>
          <span className={cn(TYPE.meta, "flex min-w-0 items-center gap-1.5")}>
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              {...toneProps(workingTone(item.state), "solid")}
            />
            <span className="truncate">
              {login}
              {state === null ? null : ` · agent ${state}`}
              {item.sessions === undefined
                ? null
                : ` · ${item.sessions} ${item.sessions === 1 ? "session" : "sessions"}`}
              {atWork ? <span className="sr-only">, agent at work</span> : null}
            </span>
          </span>
        </div>
        <OpenTarget deepLink={item.deepLink} />
      </SectionRow>
    </li>
  );
}

/** One merged pull request: its summary, then "repo · #PR" linked to it, how live it is and when. */
export function ShippedRow(props: { readonly item: ShippedItem }) {
  const { item } = props;
  const href = safeLinkOut(item.pr.url);
  const label = shippedRefLabel(item.pr);
  return (
    <li className="min-w-0" data-live={item.live}>
      <SectionRow className="items-start gap-2.5 py-1.5">
        <PullRequestGlyph.merged
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0"
          {...toneProps("ok", "fg")}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="line-clamp-2 break-words text-sm">{item.summary}</span>
          <span className={cn(TYPE.meta, "truncate")}>
            {href === null ? (
              label
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {label}
              </a>
            )}
            {" · "}
            <span {...(item.live === "deploy_failed" ? toneProps("error", "fg") : {})}>
              {shippedLabel(item.live)}
            </span>
            {" · "}
            <RelativeTime at={item.mergedAt} />
          </span>
        </div>
      </SectionRow>
    </li>
  );
}

/** "Work tracker: not set up on this relay, since 6 d ago", one line per source. */
export function NotMeasuredLines(props: {
  readonly lines: ReadonlyArray<BanneretFeedNotMeasured>;
  readonly className?: string;
}) {
  return (
    <>
      {props.lines.map((line) => (
        <span key={`${line.source}:${line.since}`} className={cn("block", props.className)}>
          {humanizeWord(line.source)}: {notMeasuredReason(line.reason)}
          {line.detail === undefined ? "" : ` (${line.detail})`}{" "}
          <RelativeTime at={line.since} kind="duration" />.
        </span>
      ))}
    </>
  );
}

export function AlarmRow({
  alarm,
}: {
  readonly alarm: NonNullable<BanneretFeedToday["health"]>["alarms"][number];
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
      <StatusPill status={alarm.severity} />
      <span className={cn(TYPE.cardTitle, "break-words")}>
        <TitleLink title={alarm.title} url={alarm.url} />
      </span>
      {alarm.detail && <span className={cn(TYPE.meta, "break-words")}>{alarm.detail}</span>}
      <span className={TYPE.meta}>
        {alarm.sourceId} · <RelativeTime at={alarm.firedAt} />
      </span>
    </li>
  );
}
