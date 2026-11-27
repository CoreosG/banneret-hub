// Banneret Hub: the board for an Enterprise workspace, drawn from the relay's snapshot `board` file.
// The relay computes columns, statuses and leases; this page only draws them. A card opens its Task
// tab; its menu takes and releases through the server's LeaseService when the board flags `leases`.
import type { BanneretBoardCard, BanneretBoardTask } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import {
  boardColumns,
  boardIncomplete,
  columnCountsLine,
  columnHint,
  heldBy,
  isMine,
  mineSummary,
  needsRelease,
  prSummary,
  statusCounts,
  taskRef,
  unclaimedAssignees,
  type BoardColumnView,
} from "./board.logic";
import { BoardCardMenu } from "./BoardCardMenu";
import type { RelayTarget } from "./enrolmentStore";
import { FeedStatus } from "./FeedParts";
import { freeToContinueFirst, freeToContinueLine, isFreeToContinue } from "./lease.logic";
import { LeaseButtons, LeaseNoticeLine, useLeaseCheck } from "./LeaseControls";
import { useLeaseEntry } from "./leaseStore";
import { notMeasuredReason, offersSection } from "./relayFeed.logic";
import { LeaseChip } from "./ui/Chips";
import { PageHeader, SummaryFigure } from "./ui/PageHeader";
import { QuietLine } from "./ui/QuietLine";
import { legendStatuses } from "./ui/status";
import { RelativeTime, useNowMs } from "./ui/RelativeTime";
import { StatusLegend } from "./ui/StatusLegend";
import { TaskCard } from "./ui/TaskCard";
import {
  LAYOUT_BOARD_COLUMNS,
  RADIUS_PANEL,
  TEXT_SECTION,
  toneProps,
  type Tone,
} from "./ui/tokens";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { useOpenTask } from "./useOpenTask";
import { useTaskIssueRef } from "./useTaskIssueRef";

const CHECK_TONES: Readonly<Record<string, Tone>> = {
  passing: "ok",
  failing: "error",
  pending: "muted",
};

function PrLine(props: { readonly card: BanneretBoardCard }) {
  const summary = prSummary(props.card.prs);
  if (summary === null) return null;
  const Icon = summary.merged ? PullRequestGlyph.merged : PullRequestGlyph.pullRequest;
  return (
    <span data-pr className="inline-flex flex-wrap items-center gap-1">
      <Icon aria-hidden className="size-3 shrink-0" />
      <span>{summary.label}</span>
      {summary.checks === null ? null : (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span aria-hidden>·</span>
          <span
            data-checks={summary.checks.state}
            {...toneProps(CHECK_TONES[summary.checks.state] ?? "muted", "fg")}
          >
            {summary.checks.label}
          </span>
        </span>
      )}
    </span>
  );
}

/** How long "Taken by you" shows before the snapshot must agree. */
const TAKEN_OVERLAY_MS = 5 * 60_000;

const CHIP =
  "inline-flex min-h-5 max-w-full items-center gap-1 self-start rounded-md border px-1.5 py-0.5 font-medium text-2xs leading-4";

/**
 * A take running from this window, or one it just finished, until the relay's snapshot shows it. The
 * snapshot wins once it agrees or after five minutes.
 */
function useLocalLease(
  target: RelayTarget,
  card: BanneretBoardCard,
  me: string,
): "taking" | "taken" | null {
  const entry = useLeaseEntry(target, card.task.id);
  const nowMs = useNowMs();
  if (entry?.phase.kind === "running" && entry.phase.operation === "take") return "taking";
  const takenAt = entry?.takenAt ?? null;
  return takenAt !== null && nowMs - takenAt < TAKEN_OVERLAY_MS && !heldBy(card, me)
    ? "taken"
    : null;
}

function BoardCard(props: {
  readonly target: RelayTarget;
  readonly card: BanneretBoardCard;
  readonly atWork: boolean;
  readonly leases: boolean;
  readonly me: string;
  /** Reviewing the person's expired or incomplete claims: the card shows its lease buttons. */
  readonly review: boolean;
  readonly onOpen: (task: BanneretBoardTask) => void;
}) {
  const { card } = props;
  const lease = props.leases ? card.lease : undefined;
  const ref = taskRef(card.task);
  const localLease = useLocalLease(props.target, card, props.me);
  const local =
    !props.leases || localLease === null ? null : (
      <span
        data-local-lease={localLease}
        className={CHIP}
        {...toneProps(localLease === "taking" ? "info" : "ok", "tint", "edge", "fg")}
      >
        {localLease === "taking" ? "Taking… confirming" : "Taken by you"}
      </span>
    );
  const continues = props.leases && isFreeToContinue(card) ? card.lastRelease : undefined;
  // Without leases the relay says nothing about claims, so "not claimed" would be a guess.
  const unclaimed = props.leases ? unclaimedAssignees(card) : [];
  const assigned =
    unclaimed.length === 0 ? undefined : (
      <span
        data-testid="assigned-not-claimed"
        className={cn(CHIP, "flex-wrap")}
        {...toneProps("muted", "edge", "fg")}
      >
        assigned · not claimed · <span className="break-all">{unclaimed.join(", ")}</span>
      </span>
    );
  return (
    <li
      data-task-id={card.task.id}
      data-at-work={props.atWork ? "" : undefined}
      data-free-to-continue={continues === undefined ? undefined : ""}
      className="relative"
    >
      <TaskCard
        {...(props.leases ? { className: "pe-9" } : {})}
        title={card.task.title}
        status={card.status}
        why={card.statusWhy}
        refLabel={ref.repo}
        refNumber={ref.number}
        atWork={props.atWork}
        lease={
          local ??
          (lease === undefined ? (
            continues === undefined ? (
              assigned
            ) : (
              <span
                data-testid="free-to-continue"
                className={CHIP}
                {...toneProps("ok", "tint", "edge", "fg")}
              >
                {freeToContinueLine(continues)}
              </span>
            )
          ) : (
            <LeaseChip
              holder={lease.holder.login}
              state={lease.state}
              lastSignalAt={lease.lastSignalAt}
            />
          ))
        }
        footer={card.prs.length === 0 ? undefined : <PrLine card={card} />}
        onOpen={() => props.onOpen(card.task)}
      />
      {props.leases ? (
        <BoardCardMenu target={props.target} card={card} onOpen={props.onOpen} />
      ) : null}
      {props.review ? <ClaimReviewActions target={props.target} card={card} /> : null}
    </li>
  );
}

/**
 * The buttons for one of the person's expired or incomplete claims. They follow the server's
 * `leases.check`, read for these few cards only; Release opens the Release dialog.
 */
function ClaimReviewActions(props: {
  readonly target: RelayTarget;
  readonly card: BanneretBoardCard;
}) {
  const { card, target } = props;
  const issueRef = useTaskIssueRef(target.environmentId, card.task);
  const entry = useLeaseCheck(target, card.task.id, issueRef, true);
  if (issueRef === null) {
    return (
      <p className="px-1 pt-1 text-muted-foreground text-xs" data-testid="review-off">
        Release needs a local project for {taskRef(card.task).repo}.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 px-1 pt-1.5" data-testid="claim-review">
      <LeaseButtons
        target={target}
        taskId={card.task.id}
        title={card.task.title}
        issueRef={issueRef}
        entry={entry}
        continues={false}
      />
      <LeaseNoticeLine entry={entry} />
    </div>
  );
}

/** An empty column: a narrow strip with its name and 0; the other columns take the width. */
function EmptyColumn(props: { readonly column: BoardColumnView }) {
  const { column } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <section
            aria-label={`${column.title}, no tasks`}
            data-column-empty=""
            className="flex min-h-0 flex-col items-center border bg-muted py-3"
            {...RADIUS_PANEL}
          />
        }
      >
        <h2 data-slot="column-strip-label" className="text-muted-foreground" {...TEXT_SECTION}>
          {column.title} · <span data-count>0</span>
        </h2>
      </TooltipTrigger>
      <TooltipPopup>Nothing in {column.title} right now.</TooltipPopup>
    </Tooltip>
  );
}

function BoardColumn(props: {
  readonly target: RelayTarget;
  readonly column: BoardColumnView;
  readonly atWork: ReadonlySet<string>;
  readonly leases: boolean;
  readonly me: string;
  readonly review: boolean;
  readonly onOpen: (task: BanneretBoardTask) => void;
}) {
  const { column } = props;
  const hint = columnHint(column.id);
  if (column.cards.length === 0) return <EmptyColumn column={column} />;
  return (
    <section
      aria-label={column.title}
      className="flex min-h-0 min-w-0 flex-col border bg-muted"
      {...RADIUS_PANEL}
    >
      <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <h2 className="min-w-0 truncate" {...TEXT_SECTION}>
          {column.title}
        </h2>
        <span
          data-count
          className="rounded-full bg-accent px-1.5 font-medium text-2xs text-muted-foreground tabular-nums"
        >
          {column.cards.length}
        </span>
        {hint === undefined ? null : (
          <span className="ml-auto hidden min-w-0 truncate text-muted-foreground text-xs 2xl:inline">
            {hint}
          </span>
        )}
      </header>
      <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {(props.leases && column.id === "free"
          ? freeToContinueFirst(column.cards)
          : column.cards
        ).map((card) => (
          <BoardCard
            key={card.task.id}
            target={props.target}
            card={card}
            atWork={props.atWork.has(card.task.id)}
            leases={props.leases}
            me={props.me}
            review={props.review}
            onOpen={props.onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

/** Full width: the columns take the page and each scrolls on its own. */
function BoardFrame(props: { readonly company?: string; readonly children: ReactNode }) {
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
          <span className="font-medium">Board</span>
        </span>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-6 pb-8">
        {props.children}
      </div>
    </SidebarInset>
  );
}

const tasksLabel = (count: number) => (count === 1 ? "1 task." : `${count} tasks.`);

/** Mine: held by or assigned to the person. Review: only their expired or incomplete claims. */
type MineView = "mine" | "review";

export function BoardPage() {
  const enterprise = useEnterpriseFeed();
  const enrolment = enterprise?.enrolment ?? null;
  const openTask = useOpenTask(enterprise?.target ?? null);
  // The workspace Mine was chosen in, so switching workspaces falls back to Everyone.
  const [mineIn, setMineIn] = useState<{
    readonly workspaceId: string;
    readonly view: MineView;
  } | null>(null);
  if (enterprise === null) {
    return (
      <BoardFrame>
        <PageHeader title="Board" />
        <QuietLine
          fact="No company here yet."
          hint="Choose an Enterprise workspace that this machine has joined to see its company here."
        />
      </BoardFrame>
    );
  }
  const { feed, workspace } = enterprise;
  if (!offersSection(feed, "board")) {
    return (
      <BoardFrame company={workspace.name}>
        <PageHeader title="Board" />
        <QuietLine fact={`${workspace.name} does not offer a board.`} />
      </BoardFrame>
    );
  }
  const read = feed.board;
  const board = read?.value ?? null;
  const leases = read?.leases === true;
  const me = enrolment?.me?.login.trim() ?? "";
  const canFilter = leases && me !== "";
  const view: MineView | null =
    canFilter && mineIn?.workspaceId === workspace.id ? mineIn.view : null;
  const mine = view !== null;
  const review = view === "review";
  const toReview =
    board === null || !canFilter ? [] : board.cards.filter((c) => needsRelease(c, me));
  const cards =
    board === null
      ? []
      : review
        ? toReview
        : mine
          ? board.cards.filter((card) => isMine(card, me))
          : board.cards;
  const columns = board === null ? [] : boardColumns(board, cards);
  const atWork = new Set(read?.atWork ?? []);
  const counts = statusCounts(cards);
  const statuses = legendStatuses(counts).filter(
    (status) => read?.checked === true || status !== "checked",
  );
  const summary =
    board === null || board.cards.length === 0 ? undefined : mine ? (
      <SummaryFigure>{mineSummary(board.cards, me)}</SummaryFigure>
    ) : (
      <>
        <SummaryFigure>{tasksLabel(cards.length)}</SummaryFigure> {columnCountsLine(columns)}
      </>
    );
  return (
    <BoardFrame company={workspace.name}>
      <PageHeader title="Board" summary={summary}>
        {canFilter ? (
          <ToggleGroup
            aria-label="Whose tasks"
            variant="segmented"
            value={[mine ? "mine" : "everyone"]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "mine") setMineIn({ workspaceId: workspace.id, view: "mine" });
              else if (next === "everyone") setMineIn(null);
            }}
          >
            <Toggle value="everyone">Everyone</Toggle>
            <Toggle value="mine">Mine</Toggle>
          </ToggleGroup>
        ) : null}
      </PageHeader>
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={read?.fetchedAt ?? null}
        problem={read?.problem ?? null}
      />
      {board === null ? (
        read?.problem === undefined && !feed.unreachable ? (
          <QuietLine fact="Loading…" />
        ) : null
      ) : (
        <>
          {boardIncomplete(board) ? (
            <div
              role="note"
              className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs"
            >
              <p className="font-semibold text-foreground">
                Part of this board could not be read, so it may be incomplete.
              </p>
              <ul>
                {board.notMeasured.map((line) => (
                  <li key={`${line.source}:${line.since}`}>
                    {line.source}: {notMeasuredReason(line.reason)}{" "}
                    <RelativeTime at={line.since} kind="duration" />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {board.cards.length === 0 ? (
            <QuietLine fact="No tasks yet." hint="Tasks appear here once the tracker has some." />
          ) : (
            <>
              <StatusLegend
                counts={counts}
                statuses={statuses}
                atWorkCount={cards.filter((card) => atWork.has(card.task.id)).length}
              />
              {!review && toReview.length > 0 ? (
                <div
                  role="note"
                  data-testid="claims-nudge"
                  className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                  {...toneProps("warn", "tint", "edge")}
                >
                  <span className="min-w-0 flex-1">
                    {toReview.length === 1
                      ? "1 of your claims is expired or incomplete."
                      : `${toReview.length} of your claims are expired or incomplete.`}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setMineIn({ workspaceId: workspace.id, view: "review" })}
                  >
                    Review your expired claims
                  </Button>
                </div>
              ) : null}
              {review ? (
                <div
                  data-testid="claims-review"
                  className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                >
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    {cards.length === 0
                      ? "No expired or incomplete claims of yours left."
                      : "Your expired and incomplete claims. Release each one, or finish it."}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setMineIn({ workspaceId: workspace.id, view: "mine" })}
                  >
                    Show all of mine
                  </Button>
                </div>
              ) : mine && cards.length === 0 ? (
                <QuietLine
                  fact="Nothing of yours here."
                  hint="Tasks you take or are assigned appear here."
                />
              ) : null}
              <div className="min-h-0 flex-1" {...LAYOUT_BOARD_COLUMNS}>
                {columns.map((column) => (
                  <BoardColumn
                    key={column.id}
                    target={enterprise.target}
                    column={column}
                    atWork={atWork}
                    leases={leases}
                    me={me}
                    review={review}
                    onOpen={openTask}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </BoardFrame>
  );
}
