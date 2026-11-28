// Banneret Hub: the Task tab. The header and facts come from the board card, the relay's task read, or
// the map item; take and release sit in the header when the board flags `leases`. The body is
// upstream's issue thread when a project here is on the task's tracker, else one row that links out.
// Relay strings stay text.
import {
  ChatThreadLocation,
  allBoardCards,
  EnvironmentId,
  ThreadId,
  type BanneretBoardCard,
  type BanneretBoardPr,
  type BanneretMap,
  type BanneretMapItem,
  type BanneretTask,
  type IssueRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ExternalLinkIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { randomUUID } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { reviewRepository } from "./chat/reviewPr";
import { TaskReviews } from "./chat/AgentAskCards";
import { chatRpc } from "./chat/client";
import { chatHref } from "./chat/ChannelRows";
import { type ReactNode, useEffect, useState } from "react";

import { IssueDetailPanel } from "../components/issue/IssueDetailPanel";
import { ApprovalLine } from "./ApprovalLine";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Button } from "../components/ui/button";
import { useRightPanelStore } from "../rightPanelStore";
import { type RelayTarget, useEnrolmentView } from "./enrolmentStore";
import { taskRef } from "./board.logic";
import { lastReleaseView, releaseReasonLine, type LastReleaseView } from "./lease.logic";
import { LeaseButtons, LeaseNoticeLine, routeMachine, useLeaseCheck } from "./LeaseControls";
import { useLeaseRoute } from "./leaseMachineStore";
import { routeProblem, type LeaseRoute } from "./leaseRoute.logic";
import type { LeaseEntry } from "./leaseStore";
import { blockedByName } from "./map.logic";
import { mapItemForTask, neighbourhoodSearch } from "./mapGraph.logic";
import { useEnvironmentFeed, watchFeed } from "./relayFeedStore";
import { safeLinkOut } from "./relayFeed.logic";
import { checkedView, previewStateLabel, restsOnItems, trackerName } from "./task.logic";
import { openTaskDialog, useTaskRead } from "./taskStore";
import { decodeTaskSurface, type TaskIdentity, type TaskSurface } from "./taskSurface";
import { LeaseChip } from "./ui/Chips";
import { EMPTY_NONE, EMPTY_NOT_KNOWN } from "./ui/labels";
import { FactsGrid, type Fact } from "./ui/FactsGrid";
import { RelativeTime } from "./ui/RelativeTime";
import { StatusPill } from "./ui/StatusPill";
import { TEXT_DIALOG_TITLE, TYPE, toneProps, type Tone } from "./ui/tokens";
import { useTaskIssueRef } from "./useTaskIssueRef";
import { OwnedElsewhere } from "./OwnedElsewhere";

const CHECK_TONES: Readonly<Record<string, Tone>> = {
  passing: "ok",
  failing: "error",
  pending: "muted",
};
const CHECK_WORDS: Readonly<Record<string, string>> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks pending",
};
const PR_WORDS: Readonly<Record<string, string>> = {
  open: "open",
  merged: "merged",
  closed: "closed",
};

const CHIP =
  "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 font-medium text-2xs";

function LinkOut(props: { readonly url: string | undefined; readonly children: ReactNode }) {
  const href = safeLinkOut(props.url);
  if (href === null) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
    >
      {props.children}
      <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

/** One linked pull request: number and state, linked, with its checks when the relay read them. */
function PrRow(props: { readonly pr: BanneretBoardPr }) {
  const { pr } = props;
  const Icon = pr.state === "merged" ? PullRequestGlyph.merged : PullRequestGlyph.pullRequest;
  const href = safeLinkOut(pr.url);
  const label = `#${pr.number} ${PR_WORDS[pr.state] ?? pr.state.replaceAll("_", " ")}`;
  const checks = pr.checks?.state;
  return (
    <span
      className="flex flex-wrap items-center gap-2"
      data-pr={pr.number}
      data-pr-state={pr.state}
    >
      {href === null ? (
        <span className="inline-flex items-center gap-1">
          <Icon aria-hidden className="size-3.5 shrink-0" />
          {label}
        </span>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:underline"
        >
          <Icon aria-hidden className="size-3.5 shrink-0" />
          {label}
        </a>
      )}
      {checks === undefined ? null : (
        <span
          data-checks={checks}
          className={CHIP}
          {...toneProps(CHECK_TONES[checks] ?? "muted", "tint", "edge", "fg")}
        >
          {CHECK_WORDS[checks] ?? `Checks ${checks.replaceAll("_", " ")}`}
        </span>
      )}
    </span>
  );
}

/** The sign-off fact; null (left out) when there is nothing to say and no sign-off link to offer. */
function checkedValue(props: {
  readonly checked: BanneretTask["checked"];
  readonly signOff: boolean;
  readonly task: TaskIdentity;
}): ReactNode {
  const view = checkedView(props.checked);
  if (view.kind === "none" && !props.signOff) return null;
  return (
    <span className="flex flex-col gap-1" data-testid="task-checked">
      {view.kind === "valid" ? (
        <span data-checked="valid">{view.by === "" ? "Checked" : `Checked by ${view.by}`}</span>
      ) : null}
      {view.kind === "ignored" ? (
        <span role="note" data-checked="ignored" className="text-muted-foreground text-xs">
          <span className="block">
            {view.by === ""
              ? "A checked label is on this task, but it does not count."
              : `${view.by} added the checked label, but it does not count.`}
          </span>
          <span className="block">{view.reason}</span>
        </span>
      ) : null}
      {view.kind === "none" ? <span className={TYPE.meta}>Not checked yet</span> : null}
      {props.signOff && view.kind !== "valid" ? (
        <LinkOut url={props.task.ref.url}>
          Sign off on {trackerName(props.task.ref.tracker)}
        </LinkOut>
      ) : null}
    </span>
  );
}

function LastReleaseValue(props: { readonly release: LastReleaseView }) {
  const { release } = props;
  return (
    <span className="flex min-w-0 flex-col gap-1.5" data-testid="task-last-release">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{release.by}</span>
        <span>{releaseReasonLine(release)}</span>
        {release.freeToContinue ? (
          <span className={CHIP} {...toneProps("ok", "tint", "edge", "fg")}>
            Free to continue
          </span>
        ) : null}
      </span>
      {release.note === undefined ? null : (
        <span
          data-testid="task-last-release-note"
          className="block max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-1.5 text-xs"
        >
          {release.note}
        </span>
      )}
    </span>
  );
}

/** A fact that opens a map item's neighbourhood, or plain text when there is none to open. */
function MapLink(props: {
  readonly itemId: string | null;
  readonly showOnMap: ((itemId: string) => void) | null;
  readonly children: ReactNode;
}) {
  const { itemId, showOnMap } = props;
  if (itemId === null || showOnMap === null) return <>{props.children}</>;
  return (
    <button
      type="button"
      data-map-link={itemId}
      onClick={() => showOnMap(itemId)}
      className="cursor-pointer text-left underline decoration-border underline-offset-2 hover:decoration-foreground"
    >
      {props.children}
    </button>
  );
}

interface TaskView {
  readonly task: TaskIdentity;
  readonly card: BanneretBoardCard | BanneretTask | null;
  readonly mapItem: BanneretMapItem | null;
  readonly map: BanneretMap | null;
  readonly relayTask: BanneretTask | null;
  readonly cards: ReadonlyArray<BanneretBoardCard>;
  /** The relay answered 404 and no board card holds the task. */
  readonly notFound: boolean;
}

function taskFacts(
  view: TaskView,
  options: {
    readonly leases: boolean;
    /** The company source that owns claims, by title; its answer alone says who holds the task. */
    readonly source: string | undefined;
    readonly signOff: boolean;
    readonly lease: LeaseEntry | undefined;
    /** Opens a map item's neighbourhood; null when the relay offers none. */
    readonly showOnMap: ((itemId: string) => void) | null;
  },
): ReadonlyArray<Fact> {
  const { card, mapItem, map, relayTask } = view;
  const dated = card?.task ?? mapItem?.task ?? null;
  const stage =
    mapItem === null ? null : (map?.stages.find((entry) => entry.id === mapItem.stageId) ?? null);
  const restsOn = card === null ? [] : restsOnItems(card.restsOn, view.cards);
  const preview = relayTask?.preview;
  const prs = (relayTask ?? card)?.prs ?? [];
  const held = card?.lease;
  // The relay's snapshot lags a take or release; the tracker's own answer is newer.
  const checked = options.lease?.status?.lease ?? null;
  const release = options.leases
    ? lastReleaseView(options.lease?.status ?? null, card?.lastRelease)
    : null;
  const claimed = options.lease?.status?.availability === "available" ? options.lease.status : null;
  const sourceFacts =
    options.source === undefined
      ? null
      : {
          owner:
            claimed === null ? undefined : (
              <span className="flex flex-wrap items-center gap-2" data-testid="owner-from-source">
                {claimed.lease === null ? (
                  <span className={TYPE.meta}>Nobody holds it, says {options.source}</span>
                ) : (
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{claimed.lease.holder}</span>, says{" "}
                    {options.source}
                  </span>
                )}
              </span>
            ),
          lastRelease: claimed?.lastRelease ? (
            <LastReleaseValue release={claimed.lastRelease} />
          ) : undefined,
        };
  const dates: ReadonlyArray<Fact> = [
    {
      label: "Opened",
      value:
        dated === null ? undefined : (
          <span data-testid="task-opened">
            <RelativeTime at={dated.openedAt} />
          </span>
        ),
    },
    {
      label: "Closed",
      empty: dated !== null && dated.closedAt === null ? "Still open" : EMPTY_NOT_KNOWN,
      value:
        dated?.closedAt == null ? undefined : (
          <span data-testid="task-closed">
            <RelativeTime at={dated.closedAt} />
          </span>
        ),
    },
  ];
  if (view.notFound) {
    return [
      { label: "Owner", value: options.leases || sourceFacts ? sourceFacts?.owner : null },
      ...dates,
      { label: "Pull request", value: undefined },
      { label: "Stage", value: stage?.title, empty: "Not on the map" },
      {
        label: "Status",
        value:
          mapItem === null ? undefined : (
            <span className={TYPE.meta} data-testid="task-status-why">
              From the build map. {mapItem.statusWhy}
            </span>
          ),
      },
    ];
  }
  return [
    {
      label: "Owner",
      value: sourceFacts ? (
        sourceFacts.owner
      ) : !options.leases ? null : card === null ? undefined : held === undefined ? (
        checked === null ? (
          <span className={TYPE.meta}>Nobody holds it</span>
        ) : (
          <span className="flex flex-wrap items-center gap-2" data-testid="owner-from-tracker">
            <span className="font-medium">{checked.holder}</span>
          </span>
        )
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <LeaseChip holder={held.holder.login} state={held.state} staleAt={held.staleAt} />
        </span>
      ),
    },
    ...dates,
    {
      label: card !== null && card.prs.length > 1 ? "Pull requests" : "Pull request",
      empty: card === null ? EMPTY_NOT_KNOWN : EMPTY_NONE,
      value:
        card === null || card.prs.length === 0 ? undefined : (
          <span className="flex flex-col gap-1">
            {card.prs.map((pr) => (
              <PrRow key={pr.number} pr={pr} />
            ))}
          </span>
        ),
    },
    {
      label: "Merge approvals",
      value: prs.length ? (
        <span>
          {prs.map((pr) => (
            <ApprovalLine key={pr.number} pr={pr} detail numbered={prs.length > 1} />
          ))}
        </span>
      ) : undefined,
      empty: card === null ? EMPTY_NOT_KNOWN : EMPTY_NONE,
    },
    {
      label: "Stage",
      empty: "Not on the map",
      value:
        stage === null || mapItem === null ? undefined : (
          <MapLink itemId={mapItem.id} showOnMap={options.showOnMap}>
            {stage.title}
          </MapLink>
        ),
    },
    {
      label: "Preview",
      empty: relayTask === null ? EMPTY_NOT_KNOWN : EMPTY_NONE,
      value:
        preview === undefined ? undefined : (
          <span className="flex flex-wrap items-center gap-2">
            <span data-preview={preview.state}>{previewStateLabel(preview.state)}</span>
            <LinkOut url={preview.url}>Open preview</LinkOut>
          </span>
        ),
    },
    {
      label: "Rests on",
      empty: card === null ? EMPTY_NOT_KNOWN : EMPTY_NONE,
      value:
        restsOn.length === 0 ? undefined : (
          <span className="flex flex-col">
            {restsOn.map((item) => (
              <span key={item.id} data-rests-on={item.id} className="break-words">
                <MapLink
                  itemId={mapItemForTask(map, item.id)?.id ?? null}
                  showOnMap={options.showOnMap}
                >
                  {item.title ?? item.id}
                </MapLink>
              </span>
            ))}
          </span>
        ),
    },
    {
      label: "Check",
      value: checkedValue({
        checked: relayTask?.checked,
        signOff: options.signOff,
        task: view.task,
      }),
    },
    {
      label: "Last release",
      // A source that could not be asked is not one with no release.
      empty: sourceFacts && claimed === null ? EMPTY_NOT_KNOWN : EMPTY_NONE,
      wide: (sourceFacts ? claimed?.lastRelease?.note : release?.note) !== undefined,
      value: sourceFacts ? (
        sourceFacts.lastRelease
      ) : !options.leases ? null : release === null ? undefined : (
        <LastReleaseValue release={release} />
      ),
    },
  ];
}

const decodeThreadLocation = Schema.decodeUnknownSync(ChatThreadLocation);

function TaskHeader(props: {
  readonly target: RelayTarget;
  readonly view: TaskView;
  readonly atWork: boolean;
  readonly route: LeaseRoute;
  readonly hasIssueRef: boolean;
  /** The company source that owns tasks, by title: the link out names it. */
  readonly trackerTitle: string | undefined;
  /** Take and release run here: Banneret's leases, or a company source's own claims. */
  readonly leases: boolean;
  /** A company source owns tasks but the relay does not leave claims to it, by title. */
  readonly claimsOff: string | undefined;
  readonly lease: LeaseEntry | undefined;
  readonly note: string | null;
}) {
  const { view } = props;
  const { card, mapItem } = view;
  const status = card?.status ?? mapItem?.status ?? null;
  const why = card?.statusWhy ?? (view.notFound ? undefined : mapItem?.statusWhy);
  const blockedBy =
    card !== null || mapItem === null || view.map === null
      ? null
      : blockedByName(view.map, mapItem);
  const ref = taskRef({ ...view.task, openedAt: "", closedAt: null });
  const href = safeLinkOut(view.task.ref.url);
  const tracker = props.trackerTitle ?? trackerName(view.task.ref.tracker);
  const release = lastReleaseView(props.lease?.status ?? null, card?.lastRelease);
  const source = props.route.kind === "ready" ? props.route.source : undefined;
  return (
    <header className="flex shrink-0 flex-col gap-2 px-4 pt-4 pb-3" data-testid="task-header">
      <div className="flex min-w-0 items-start gap-2">
        <h2 className="min-w-0 flex-1 break-words" {...TEXT_DIALOG_TITLE}>
          {card?.task.title ?? view.task.title}
        </h2>
        {href === null ? null : (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Open on ${tracker}`}
            title={`Open on ${tracker}`}
            data-testid="task-link-out-icon"
            render={<a href={href} target="_blank" rel="noopener noreferrer" />}
          >
            <SquareArrowOutUpRightIcon aria-hidden />
          </Button>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {status === null ? null : (
          <StatusPill
            status={status}
            why={why}
            atWork={props.atWork}
            blockedBy={blockedBy ?? undefined}
          />
        )}
        <span className={TYPE.ref} data-testid="task-ref">
          {ref.repo}
          {ref.number}
        </span>
        <span className="flex-1" />
        {props.leases && props.route.kind === "ready" ? (
          <LeaseButtons
            target={props.target}
            taskId={view.task.id}
            title={card?.task.title ?? view.task.title}
            route={props.route}
            entry={props.lease}
            continues={release?.freeToContinue === true}
          />
        ) : null}
      </div>
      {why === undefined || why === "" ? null : (
        <p className={TYPE.meta} data-testid="task-status-why">
          {why}
        </p>
      )}
      {props.leases ? <LeaseNoticeLine entry={props.lease} source={source} /> : null}
      <OwnedElsewhere capabilities={["tasks"]} />
      {source !== undefined && props.route.kind === "ready" ? (
        <p className={TYPE.meta} data-testid="lease-source">
          Take and release use your sign-in to {source} on {props.route.chosen.label}.
        </p>
      ) : null}
      {props.claimsOff === undefined ? null : (
        <p className={TYPE.meta} role="status" data-testid="lease-source-off">
          {props.claimsOff} owns tasks, but the relay does not leave claims to it, so take and
          release are off.
        </p>
      )}
      {/* Without any project here the link row below already says so. */}
      {props.leases &&
      routeProblem(props.route) !== null &&
      (props.route.kind !== "none" || props.hasIssueRef) ? (
        <p className={TYPE.meta} role="status" data-testid="lease-route-problem">
          {routeProblem(props.route)}
        </p>
      ) : null}
      {props.note === null ? null : (
        <p className={TYPE.meta} role="status">
          {props.note}
        </p>
      )}
    </header>
  );
}

/** The row in place of the thread: no project here is on the tracker, or the relay has no details. */
function LinkRow(props: {
  readonly task: TaskIdentity;
  readonly notFound: boolean;
  readonly trackerTitle: string | undefined;
}) {
  const href = safeLinkOut(props.task.ref.url);
  const repo = taskRef({ ...props.task, openedAt: "", closedAt: null }).repo;
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t px-4 py-3 text-sm"
      data-testid="task-link-out"
    >
      <SquareArrowOutUpRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      {props.notFound ? (
        <span className="text-muted-foreground">Details from the relay aren't available.</span>
      ) : (
        <span>
          No local project for <span className="font-medium">{repo}</span>
        </span>
      )}
      <span className="flex-1" />
      {href === null ? null : (
        <Button
          size="sm"
          variant="outline"
          render={<a href={href} target="_blank" rel="noopener noreferrer" />}
        >
          Open on {props.trackerTitle ?? trackerName(props.task.ref.tracker)}
        </Button>
      )}
    </div>
  );
}

/**
 * Upstream's issue thread and composer for the task, through the project here that is on the task's
 * tracker and scope. Comments post on the person's own login.
 */
function TaskThread(props: {
  readonly environmentId: EnvironmentId;
  readonly task: TaskIdentity;
  readonly issueRef: IssueRef;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { environmentId, task, threadRef } = props;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-t"
      data-testid="task-thread"
      data-task-thread
    >
      <p className="px-4 pt-2 text-muted-foreground text-xs" data-testid="task-thread-help">
        Edits here are made on {trackerName(task.ref.tracker)} as you; the board's rules for claims
        and sign-off still apply.
      </p>
      <IssueDetailPanel
        environmentId={environmentId}
        reference={props.issueRef}
        threadRef={threadRef}
        onSelectPullRequest={
          threadRef === null
            ? undefined
            : (reference) =>
                useRightPanelStore.getState().openPullRequest(threadRef, {
                  ...(threadRef.environmentId === environmentId ? {} : { environmentId }),
                  projectId: reference.projectId,
                  repository: reference.repository,
                  number: reference.number,
                  ...(reference.host ? { host: reference.host } : {}),
                })
        }
        onSelectIssue={
          threadRef === null
            ? undefined
            : ({ host, ...reference }) =>
                useRightPanelStore.getState().openIssue(threadRef, {
                  ...(threadRef.environmentId === environmentId ? {} : { environmentId }),
                  ...reference,
                  ...(host ? { host } : {}),
                })
        }
      />
    </div>
  );
}

export function TaskPanel(props: {
  /** A saved surface may be malformed, so the panel decodes it before reading. */
  readonly surface: unknown;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const surface = decodeTaskSurface(props.surface);
  if (surface === null) {
    return (
      <p className="p-3 text-muted-foreground text-sm" role="status">
        This task can no longer be shown.
      </p>
    );
  }
  return <TaskPanelBody key={surface.id} surface={surface} threadRef={props.threadRef} />;
}

function TaskPanelBody(props: {
  readonly surface: TaskSurface;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { surface } = props;
  const environmentId = EnvironmentId.make(surface.environmentId);
  const { relayOrigin } = surface;
  // The task's own relay, whichever workspace is active: the surface names it.
  const target = { environmentId, relayOrigin };
  const taskId = surface.task.id;
  const feed = useEnvironmentFeed(target);
  const enrolment = useEnrolmentView(environmentId, relayOrigin);
  const issueRef = useTaskIssueRef(environmentId, surface.task);
  const leases = feed.board?.leases === true;
  // With tasks owned by a company source, its claims decide, whatever the board's `leases` flag says.
  const tasksOwner = feed.elsewhere?.tasks?.owner === "external" ? feed.elsewhere.tasks : undefined;
  const source = tasksOwner && !tasksOwner.leases ? tasksOwner.title : undefined;
  const claims = tasksOwner ? source !== undefined : leases;
  const route = useLeaseRoute(target, surface.task);
  const lease = useLeaseCheck(target, taskId, routeMachine(route), claims);

  // A thread's panel has no page following the feed, so the tab follows it while shown.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's relay feed while the Task tab is shown
  useEffect(() => watchFeed({ environmentId, relayOrigin }), [environmentId, relayOrigin]);

  // Every board's cards: a task can open from search on a board that is not the one shown.
  const boardCards = allBoardCards(feed.board?.value);
  const card = boardCards.find((candidate) => candidate.task.id === taskId) ?? null;
  // The map carries every planned task, closed issues included, that the relay may not serve.
  const mapItem = feed.map?.value?.items.find((item) => item.task?.id === taskId) ?? null;
  // Only a relay that advertises the section serves the read; any other relay answers 404 for a task
  // that exists.
  const offered = feed.joined && feed.sectionsKnown && feed.sections.includes("task");
  const read = useTaskRead(target, taskId, offered, feed.board?.fetchedAt ?? null);

  const answer = read.kind === "done" ? read.read : null;
  const relayTask = answer?.value ?? null;
  const shown = card ?? relayTask;
  const known = shown !== null || mapItem !== null;
  const notFound = answer?.notFound === true && shown === null;
  const view: TaskView = {
    task: surface.task,
    card: shown,
    mapItem,
    map: feed.map?.value ?? null,
    relayTask,
    cards: boardCards,
    notFound,
  };
  const note =
    read.kind === "loading" && !known
      ? "Loading…"
      : notFound && issueRef !== null
        ? "Details from the relay aren't available."
        : answer?.problem !== undefined && !known
          ? answer.problem.message
          : read.kind === "done" && answer === null && !known
            ? "The task could not be read."
            : null;
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [discussionError, setDiscussionError] = useState("");
  const [noThread, setNoThread] = useState(false);
  async function discuss() {
    setOpening(true);
    setDiscussionError("");
    setNoThread(false);
    try {
      const result = await chatRpc.run(target, { kind: "discuss", id: taskId });
      const location = decodeThreadLocation(result);
      await navigate({ href: chatHref(location.conversationId, location.threadRootId) });
      openTaskDialog(null);
    } catch (e) {
      // The relay refuses a task a thread with either code.
      const { code } = e as { code?: string };
      if (code === "not_found" || code === "forbidden") setNoThread(true);
      else setDiscussionError(String(e));
    }
    setOpening(false);
  }
  const showOnMap =
    feed.map?.restsOn === true
      ? (itemId: string) => {
          openTaskDialog(null);
          void navigate({ to: "/map", search: neighbourhoodSearch(itemId) } as never);
        }
      : null;
  const facts = taskFacts(view, {
    leases: claims && source === undefined,
    source,
    signOff: enrolment?.me?.permissions.includes("relay.admin") ?? false,
    lease,
    showOnMap,
  });
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-task-panel={surface.task.id}
      data-task-narrow={notFound ? "" : undefined}
    >
      <TaskHeader
        target={target}
        view={view}
        atWork={feed.board?.atWork.includes(taskId) === true}
        route={route}
        hasIssueRef={issueRef !== null}
        leases={claims}
        claimsOff={tasksOwner?.leases ? tasksOwner.title : undefined}
        trackerTitle={tasksOwner?.title}
        lease={lease}
        note={note}
      />
      {feed.chatFlags?.includes("reviews") && shown && shown.prs.length > 0 && (
        <TaskReviews
          target={target}
          card={shown}
          revision={feed.chatRevision ?? 0}
          owner={feed.chatFlags.includes("promote") ? enrolment?.me?.login : undefined}
        />
      )}
      {feed.chatFlags?.includes("reviews") &&
        feed.team?.value?.people.length === 1 &&
        shown?.prs
          .filter((pr) => pr.state === "open" && pr.headSha && reviewRepository(pr))
          .map((pr) => (
            <div key={pr.number} className="px-4 pb-2">
              <Button
                variant="outline"
                size="sm"
                disabled={opening}
                onClick={async () => {
                  setOpening(true);
                  try {
                    const threadId = await chatRpc.run(target, {
                      kind: "selfCheck",
                      pr: { repo: reviewRepository(pr)!, number: pr.number, headSha: pr.headSha! },
                      key: randomUUID(),
                      ...(props.threadRef && { thread: props.threadRef.threadId }),
                    });
                    if (typeof threadId === "string") {
                      await navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams({
                          environmentId,
                          threadId: ThreadId.make(threadId),
                        }),
                      });
                      openTaskDialog(null);
                    }
                  } catch (e) {
                    setDiscussionError(String(e));
                  }
                  setOpening(false);
                }}
              >
                Self-check #{pr.number}
              </Button>
              <small>
                {" "}
                Runs in a fresh thread. A self-check never counts as a second approval.
              </small>
            </div>
          ))}
      {feed.chatFlags?.includes("task_links") && !notFound && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <Button variant="outline" size="sm" disabled={opening} onClick={() => void discuss()}>
            Discuss this task
          </Button>
        </div>
      )}
      {noThread && (
        <p role="status" className="px-4 pb-2 text-muted-foreground text-sm">
          This task has no chat thread you can open. A thread needs a channel for its board where
          everyone can see the task. Follow the task here instead.
        </p>
      )}
      {discussionError && <span role="alert">{discussionError}</span>}
      <FactsGrid
        facts={facts}
        className={notFound ? "shrink-0 px-4 pb-3 sm:grid-cols-1" : "shrink-0 px-4 pb-3"}
      />
      {issueRef === null ? (
        <LinkRow task={surface.task} notFound={notFound} trackerTitle={tasksOwner?.title} />
      ) : (
        <TaskThread
          environmentId={environmentId}
          task={surface.task}
          issueRef={issueRef}
          threadRef={props.threadRef}
        />
      )}
    </div>
  );
}
