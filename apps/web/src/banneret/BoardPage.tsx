// Banneret Hub: the board for an Enterprise workspace, drawn from the relay's snapshot `board` file.
// The relay computes columns, statuses and leases; this page only draws them. A card opens its Task
// tab; its menu takes and releases through the server's LeaseService when the board flags `leases`.
import type { BanneretBoardCard, BanneretBoardTask, EnvironmentId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { isElectron } from "../env";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { SidebarInset } from "../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import {
  boardColumns,
  boardIncomplete,
  columnCountsLine,
  columnHint,
  heldBy,
  prSummary,
  statusCounts,
  taskRef,
  type BoardColumnView,
} from "./board.logic";
import { BoardCardMenu } from "./BoardCardMenu";
import { useEnrolmentView } from "./enrolmentStore";
import { FeedStatus, When } from "./FeedParts";
import { freeToContinueFirst, freeToContinueLine, isFreeToContinue } from "./lease.logic";
import { useLeaseEntry } from "./leaseStore";
import { notMeasuredReason, offersSection } from "./relayFeed.logic";
import { LeaseChip } from "./ui/Chips";
import { PageHeader, SummaryFigure } from "./ui/PageHeader";
import { QuietLine } from "./ui/QuietLine";
import { legendStatuses } from "./ui/status";
import { useNowMs } from "./ui/RelativeTime";
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
  environmentId: EnvironmentId,
  card: BanneretBoardCard,
  me: string,
): "taking" | "taken" | null {
  const entry = useLeaseEntry(environmentId, card.task.id);
  const nowMs = useNowMs();
  if (entry?.phase.kind === "running" && entry.phase.operation === "take") return "taking";
  const notice = entry?.notice;
  return notice?.outcome === "taken" && nowMs - notice.at < TAKEN_OVERLAY_MS && !heldBy(card, me)
    ? "taken"
    : null;
}

function BoardCard(props: {
  readonly environmentId: EnvironmentId;
  readonly card: BanneretBoardCard;
  readonly atWork: boolean;
  readonly leases: boolean;
  readonly me: string;
  readonly onOpen: (task: BanneretBoardTask) => void;
}) {
  const { card } = props;
  const lease = props.leases ? card.lease : undefined;
  const ref = taskRef(card.task);
  const localLease = useLocalLease(props.environmentId, card, props.me);
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
            continues === undefined ? undefined : (
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
        <BoardCardMenu environmentId={props.environmentId} card={card} onOpen={props.onOpen} />
      ) : null}
    </li>
  );
}

function BoardColumn(props: {
  readonly environmentId: EnvironmentId;
  readonly column: BoardColumnView;
  readonly atWork: ReadonlySet<string>;
  readonly leases: boolean;
  readonly me: string;
  readonly onOpen: (task: BanneretBoardTask) => void;
}) {
  const { column } = props;
  const hint = columnHint(column.id);
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
      {column.cards.length === 0 ? (
        <div className="px-2 pb-2">
          <QuietLine fact="No tasks." />
        </div>
      ) : (
        <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {(props.leases && column.id === "free"
            ? freeToContinueFirst(column.cards)
            : column.cards
          ).map((card) => (
            <BoardCard
              key={card.task.id}
              environmentId={props.environmentId}
              card={card}
              atWork={props.atWork.has(card.task.id)}
              leases={props.leases}
              me={props.me}
              onOpen={props.onOpen}
            />
          ))}
        </ul>
      )}
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
const yoursLabel = (count: number) =>
  count === 1 ? "You hold 1 task." : `You hold ${count} tasks.`;

export function BoardPage() {
  const enterprise = useEnterpriseFeed();
  const enrolment = useEnrolmentView(enterprise?.environmentId ?? null);
  const openTask = useOpenTask(enterprise?.environmentId ?? "");
  // The workspace Mine was chosen in, so switching workspaces falls back to Everyone.
  const [mineIn, setMineIn] = useState<string | null>(null);
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
  const mine = canFilter && mineIn === workspace.id;
  const cards =
    board === null ? [] : mine ? board.cards.filter((card) => heldBy(card, me)) : board.cards;
  const columns = board === null ? [] : boardColumns(board, cards);
  const atWork = new Set(read?.atWork ?? []);
  const counts = statusCounts(cards);
  const statuses = legendStatuses(counts).filter(
    (status) => read?.checked === true || status !== "checked",
  );
  const summary =
    board === null || board.cards.length === 0 ? undefined : mine && cards.length === 0 ? (
      <SummaryFigure>You hold no tasks.</SummaryFigure>
    ) : (
      <>
        <SummaryFigure>{mine ? yoursLabel(cards.length) : tasksLabel(cards.length)}</SummaryFigure>{" "}
        {columnCountsLine(columns)}
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
              if (next === "mine") setMineIn(workspace.id);
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
                    {line.source}: {notMeasuredReason(line.reason)} since <When at={line.since} />
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
              {mine && cards.length === 0 ? (
                <QuietLine fact="Nothing of yours here." hint="Tasks you take appear here." />
              ) : null}
              <div className="min-h-0 flex-1" {...LAYOUT_BOARD_COLUMNS}>
                {columns.map((column) => (
                  <BoardColumn
                    key={column.id}
                    environmentId={enterprise.environmentId}
                    column={column}
                    atWork={atWork}
                    leases={leases}
                    me={me}
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
