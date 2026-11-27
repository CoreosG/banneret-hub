// Banneret Hub: the board for an Enterprise workspace, drawn from the relay's snapshot `board` file.
// The relay computes columns, statuses and leases; this page only draws them. Read-only: a lease is
// taken or released on the tracker. A card opens its Task tab.
import type { BanneretBoardCard, BanneretBoardTask } from "@t3tools/contracts";

import { FeedStatus, LeaseChipView, useNowMs, When } from "./FeedParts";
import { boardColumns, boardIncomplete, prLines } from "./board.logic";
import { notMeasuredReason, offersSection } from "./relayFeed.logic";
import { StatusLegend, StatusMark } from "./StatusLegend";
import { FeedPage, NotJoinedNote } from "./TodayPage";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { useOpenTask } from "./useOpenTask";

function BoardCardView(props: {
  readonly card: BanneretBoardCard;
  readonly atWork: boolean;
  readonly leases: boolean;
  readonly nowMs: number;
  readonly onOpen: (task: BanneretBoardTask) => void;
}) {
  const { card } = props;
  const prs = prLines(card);
  return (
    <li data-task-id={card.task.id} data-at-work={props.atWork ? "" : undefined}>
      <button
        type="button"
        data-open-task={card.task.id}
        className="flex w-full flex-col gap-1.5 rounded-md border bg-card p-2.5 text-start text-card-foreground shadow-xs/5 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => props.onOpen(card.task)}
      >
        <StatusMark status={card.status} why={card.statusWhy} atWork={props.atWork} />
        <span className="break-words text-sm">{card.task.title}</span>
        {prs.map((line) => (
          <span key={line} data-pr className="text-muted-foreground text-xs">
            {line}
          </span>
        ))}
        {props.leases ? <LeaseChipView lease={card.lease} nowMs={props.nowMs} /> : null}
      </button>
    </li>
  );
}

export function BoardPage() {
  const enterprise = useEnterpriseFeed();
  const nowMs = useNowMs();
  const openTask = useOpenTask(enterprise?.environmentId ?? "");
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
          <StatusLegend checked={read?.checked === true} />
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
                        onOpen={openTask}
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
