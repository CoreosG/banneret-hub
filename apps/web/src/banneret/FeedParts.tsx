// Banneret Hub: pieces the Enterprise pages share. Every relay string renders as plain text.
import { CloudOffIcon, PauseIcon } from "lucide-react";

import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { formatDateTimeTimestamp, formatRelativeTimeLabel } from "../timestampFormat";
import type { EnvironmentFeed } from "./relayFeedStore";
import { RelativeTime } from "./ui/RelativeTime";
import { toneProps } from "./ui/tokens";

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
  const Icon = away ? CloudOffIcon : PauseIcon;
  return (
    <p
      role="status"
      className="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs"
      {...toneProps(away ? "warn" : "muted", "tint", "edge")}
    >
      <Icon
        aria-hidden
        className="size-3.5 shrink-0"
        {...toneProps(away ? "warn" : "muted", "fg")}
      />
      <span className="min-w-0">
        {away ? (
          <>
            {props.problem?.message ??
              (feed.unreachable ? "This machine's Banneret Hub cannot be reached." : null)}{" "}
            {props.fetchedAt === null ? (
              `Nothing from ${props.company} yet.`
            ) : (
              <>
                Showing what {props.company} said <RelativeTime at={props.fetchedAt} />.
              </>
            )}
          </>
        ) : feed.liveSince === null ? null : (
          <>
            Live updates paused since <RelativeTime at={feed.liveSince} />.
          </>
        )}
      </span>
    </p>
  );
}
