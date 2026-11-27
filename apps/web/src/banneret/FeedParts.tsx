// Banneret Hub: pieces the Enterprise pages share. Every relay string renders as plain text.
import type { BanneretBoardLease } from "@t3tools/contracts";
import { CloudOffIcon, PauseIcon } from "lucide-react";

import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { formatDateTimeTimestamp, formatRelativeTimeLabel } from "../timestampFormat";
import type { EnvironmentFeed } from "./relayFeedStore";
import { leaseChip, type LeaseTone } from "./board.logic";
import { RelativeTime } from "./ui/RelativeTime";
import { toneProps } from "./ui/tokens";

// Reads the minute tick because the compiler caches a render-time Date.now().
export function useNowMs(): number {
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

const CHIP_TONE: Record<LeaseTone, string> = {
  ok: "border-success/40 text-success-foreground",
  warn: "border-warning/50 bg-warning/10 text-warning-foreground",
  error: "border-destructive/50 bg-destructive/10 text-destructive-foreground",
  muted: "border-border text-muted-foreground",
};

/** A lease chip: holder and state, toned by how worried to be. Board cards and the Task tab share it. */
export function LeaseChipView(props: {
  readonly lease: BanneretBoardLease | undefined;
  readonly nowMs: number;
}) {
  const lease = props.lease;
  if (lease === undefined) return null;
  const chip = leaseChip(lease, props.nowMs);
  return (
    <span
      data-testid="lease-chip"
      data-lease={lease.state}
      className={cn(
        "inline-flex max-w-full self-start truncate rounded-full border px-2 py-0.5 text-xs",
        CHIP_TONE[chip.tone],
      )}
    >
      {chip.label}
    </span>
  );
}
