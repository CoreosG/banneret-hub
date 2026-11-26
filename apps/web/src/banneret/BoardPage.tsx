// Banneret Hub: the board for an Enterprise workspace, drawn from the relay's snapshot `board` file.
// The relay computes columns, statuses and leases; this page only draws them. Read-only: a lease is
// taken or released on the tracker, so a card links out to its issue.
import type { BanneretBoardCard } from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { FeedStatus, useNowMs, When } from "./FeedParts";
import { boardColumns, boardIncomplete, leaseChip, type LeaseTone, prLine } from "./board.logic";
import { notMeasuredReason, offersSection, safeLinkOut } from "./relayFeed.logic";
import { StatusLegend, StatusMark } from "./StatusLegend";
import { FeedPage, NotJoinedNote } from "./TodayPage";
import { useEnterpriseFeed } from "./useEnterpriseFeed";

const CHIP_TONE: Record<LeaseTone, string> = {
  ok: "border-success/40 text-success-foreground",
  warn: "border-warning/50 bg-warning/10 text-warning-foreground",
  error: "border-destructive/50 bg-destructive/10 text-destructive-foreground",
  muted: "border-border text-muted-foreground",
};

function LeaseChipView(props: { readonly card: BanneretBoardCard; readonly nowMs: number }) {
  const lease = props.card.lease;
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

function BoardCardView(props: {
  readonly card: BanneretBoardCard;
  readonly atWork: boolean;
  readonly leases: boolean;
  readonly nowMs: number;
}) {
  const { card } = props;
  const href = safeLinkOut(card.task.ref.url);
  const pr = prLine(card);
  const body = (
    <>
      <StatusMark status={card.status} why={card.statusWhy} atWork={props.atWork} />
      <span className="break-words text-sm">{card.task.title}</span>
      {pr === null ? null : <span className="text-muted-foreground text-xs">{pr}</span>}
      {props.leases ? <LeaseChipView card={card} nowMs={props.nowMs} /> : null}
    </>
  );
  const className =
    "flex flex-col gap-1.5 rounded-md border bg-card p-2.5 text-card-foreground shadow-xs/5";
  return (
    <li data-task-id={card.task.id} data-at-work={props.atWork ? "" : undefined}>
      {href === null ? (
        <div className={className}>{body}</div>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(className, "hover:bg-accent/50")}
        >
          {body}
        </a>
      )}
    </li>
  );
}

export function BoardPage() {
  const enterprise = useEnterpriseFeed();
  const nowMs = useNowMs();
  if (enterprise === null) {
    return (
      <FeedPage title="Board">
        <NotJoinedNote />
      </FeedPage>
    );
  }
  const { feed, workspace } = enterprise;
  if (!offersSection(feed, "board")) {
    return (
      <FeedPage title="Board">
        <p className="text-muted-foreground text-sm">{workspace.name} does not offer a board.</p>
      </FeedPage>
    );
  }
  const read = feed.board;
  const board = read?.value ?? null;
  const atWork = new Set(read?.atWork ?? []);
  return (
    <FeedPage title={`Board in ${workspace.name}`}>
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={read?.fetchedAt ?? null}
        problem={read?.problem ?? null}
      />
      {board === null ? (
        read?.problem === undefined && !feed.unreachable ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : null
      ) : (
        <>
          <StatusLegend />
          {boardIncomplete(board) ? (
            <div
              role="note"
              className="rounded-md bg-muted px-3 py-2 text-muted-foreground text-xs"
            >
              <p>Part of this board could not be read, so it may be incomplete.</p>
              <ul>
                {board.notMeasured.map((line) => (
                  <li key={`${line.source}:${line.since}`}>
                    {line.source}: {notMeasuredReason(line.reason)} since <When at={line.since} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {board.cards.length === 0 ? (
            <p className="text-muted-foreground text-sm">No tasks yet.</p>
          ) : (
            <div className="flex min-w-0 gap-3 overflow-x-auto pb-2">
              {boardColumns(board).map((column) => (
                <section
                  key={column.id}
                  aria-label={column.title}
                  className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-muted/40 p-2"
                >
                  <h2 className="flex items-center gap-2 px-1 font-medium text-sm">
                    <span className="flex-1 truncate">{column.title}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {column.cards.length}
                    </span>
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {column.cards.map((card) => (
                      <BoardCardView
                        key={card.task.id}
                        card={card}
                        atWork={atWork.has(card.task.id)}
                        leases={read?.leases === true}
                        nowMs={nowMs}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </FeedPage>
  );
}
