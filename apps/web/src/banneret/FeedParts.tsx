// Banneret Hub: pieces Today and Needs you share. Every relay string renders as plain text.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type BanneretFeedDeepLink,
  type BanneretFeedNeedsItem,
  type BanneretFeedNotMeasured,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { formatDateTimeTimestamp, formatRelativeTimeLabel } from "../timestampFormat";
import type { EnvironmentFeed } from "./relayFeedStore";
import { deepLinkTarget, needsKindLabel, notMeasuredReason } from "./relayFeed.logic";

// Reads the minute tick because the compiler caches a render-time Date.now().
function useNowMs(): number {
  return Date.parse(`${useNowMinute()}:00.000Z`);
}

export function Age(props: { readonly at: string; readonly prefix?: string }) {
  const label = formatRelativeTimeLabel(props.at, useNowMs());
  if (label === "") return null;
  return (
    <time dateTime={props.at}>
      {props.prefix === undefined ? label : `${props.prefix} ${label}`}
    </time>
  );
}

/** A point in time, for "since <time>" lines. */
export function When(props: { readonly at: string }) {
  return <time dateTime={props.at}>{formatDateTimeTimestamp(props.at, "locale")}</time>;
}

/** Where an item opens: its thread here, its link out, or a note naming the machine that holds it. */
export function OpenTarget(props: {
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
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-primary hover:bg-accent"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: target.environmentId, threadId: target.threadId },
            })
          }
        >
          <MessageSquareIcon className="size-3" aria-hidden />
          Open thread
        </button>
      );
    case "link":
      return (
        <a
          href={target.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-primary hover:bg-accent"
        >
          <ExternalLinkIcon className="size-3" aria-hidden />
          Open
        </a>
      );
    case "elsewhere":
      return <span className="shrink-0 text-muted-foreground text-xs">on {target.machine}</span>;
    case "none":
      return null;
  }
}

export function NeedsItemRow(props: { readonly item: BanneretFeedNeedsItem }) {
  const { item } = props;
  return (
    <li className="flex items-start gap-3 py-2" data-kind={item.kind}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-muted-foreground text-xs">
          {needsKindLabel(item.kind)}
          {item.from === undefined ? null : ` · from ${item.from.login}`}
          {" · "}
          <Age at={item.createdAt} />
        </span>
        <span className="break-words text-sm">{item.title}</span>
        {item.recommendation === undefined ? null : (
          <span className="break-words text-muted-foreground text-xs">
            Recommended: {item.recommendation}
          </span>
        )}
      </div>
      <OpenTarget deepLink={item.deepLink} url={item.url} />
    </li>
  );
}

function NotMeasuredLines(props: { readonly lines: ReadonlyArray<BanneretFeedNotMeasured> }) {
  if (props.lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-muted-foreground text-xs">
      {props.lines.map((line) => (
        <li key={`${line.source}:${line.since}`}>
          {line.source}: not measured since <When at={line.since} />:{" "}
          {notMeasuredReason(line.reason)}
        </li>
      ))}
    </ul>
  );
}

export function FeedSection(props: {
  readonly title: ReactNode;
  readonly empty: boolean;
  readonly notMeasured: ReadonlyArray<BanneretFeedNotMeasured>;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4">
      <header className="flex items-center gap-2">
        <h2 className="flex-1 font-medium text-sm">{props.title}</h2>
        {props.action}
      </header>
      {props.empty ? (
        props.notMeasured.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing here.</p>
        ) : null
      ) : (
        props.children
      )}
      <NotMeasuredLines lines={props.notMeasured} />
    </section>
  );
}

/**
 * How fresh the page is: last-known data keeps showing with its age when the relay or this
 * environment cannot answer, and a paused live stream says since when.
 */
export function FeedStatus(props: {
  readonly feed: EnvironmentFeed;
  readonly company: string;
  readonly fetchedAt: string | null;
  readonly problem: { readonly message: string; readonly since: string } | null;
}) {
  const { feed } = props;
  const away = feed.unreachable || props.problem !== null;
  if (!away && (feed.live || feed.liveSince === null)) return null;
  return (
    <p
      role="status"
      className={cn(
        "rounded-md px-3 py-2 text-xs",
        away ? "bg-warning/10 text-warning-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {away ? (
        <>
          {props.problem?.message ??
            (feed.unreachable ? "This machine's Banneret Hub cannot be reached." : null)}{" "}
          {props.fetchedAt === null ? (
            `Nothing from ${props.company} yet.`
          ) : (
            <>
              Showing what {props.company} said <Age at={props.fetchedAt} />.
            </>
          )}
        </>
      ) : feed.liveSince === null ? null : (
        <>
          Live updates paused since <Age at={feed.liveSince} />.
        </>
      )}
    </p>
  );
}
