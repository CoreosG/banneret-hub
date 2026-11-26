// Banneret Hub: the Task tab. The header comes from the relay: the board card, one task read for the
// preview and sign-off, or the map item's status for a task only the map holds. The body is upstream's
// issue thread on the person's own tracker login when a project here is on that tracker, else a note.
// Relay strings stay text.
import {
  resolveIssueLinkTarget,
  mayContainStandaloneIssueLink,
} from "@t3tools/client-runtime/issue-links";
import {
  EnvironmentId,
  type BanneretBoardCard,
  type BanneretBoardTask,
  type BanneretMapItem,
  type BanneretTask,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";

import { IssueDetailPanel } from "../components/issue/IssueDetailPanel";
import { useRightPanelStore } from "../rightPanelStore";
import { useProjects, useServerConfigs } from "../state/entities";
import { issueTrackerEnvironment } from "../state/issueTrackers";
import { useEnvironmentQuery } from "../state/query";
import { useEnrolmentView } from "./enrolmentStore";
import { LeaseChipView, useNowMs, When } from "./FeedParts";
import { prLine } from "./board.logic";
import { useEnvironmentFeed, watchFeed } from "./relayFeedStore";
import { safeLinkOut } from "./relayFeed.logic";
import { StatusMark } from "./StatusLegend";
import { checkedView, previewStateLabel, restsOnItems, trackerName } from "./task.logic";
import { useTaskRead } from "./taskStore";
import { decodeTaskSurface, type TaskSurface } from "./taskSurface";

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
      <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
      {props.children}
    </a>
  );
}

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 break-words">
        {props.children}
      </span>
    </div>
  );
}

function CheckedSection(props: {
  readonly checked: BanneretTask["checked"];
  readonly signOff: boolean;
  readonly task: BanneretBoardTask;
}) {
  const view = checkedView(props.checked);
  return (
    <div className="flex flex-col gap-1" data-testid="task-checked">
      {view.kind === "valid" ? (
        <p className="text-xs" data-checked="valid">
          <StatusMark status="checked" />
          <span className="ms-1.5">
            {view.by === "" ? "Checked " : `Checked by ${view.by} `}
            <When at={view.at} />
          </span>
        </p>
      ) : null}
      {view.kind === "ignored" ? (
        <div
          role="note"
          data-checked="ignored"
          className="rounded-md bg-muted px-2.5 py-1.5 text-muted-foreground text-xs"
        >
          <p>
            {view.by === ""
              ? "A checked label is on this task, but it does not count."
              : `${view.by} added the checked label, but it does not count.`}
          </p>
          <p>{view.reason}</p>
        </div>
      ) : null}
      {props.signOff && view.kind !== "valid" ? (
        <LinkOut url={props.task.ref.url}>
          Sign off on {trackerName(props.task.ref.tracker)}
        </LinkOut>
      ) : null}
    </div>
  );
}

function TaskHeader(props: {
  readonly task: BanneretBoardTask;
  readonly card: BanneretBoardCard | BanneretTask | null;
  /** The map's item for the task; its status shows when neither the board nor the relay has a card. */
  readonly mapItem: BanneretMapItem | null;
  readonly relayTask: BanneretTask | null;
  readonly cards: ReadonlyArray<BanneretBoardCard>;
  readonly leases: boolean;
  readonly signOff: boolean;
  readonly note: string | null;
}) {
  const nowMs = useNowMs();
  const { card, mapItem, relayTask } = props;
  const pr = card === null ? null : prLine(card);
  const preview = relayTask?.preview;
  const restsOn = card === null ? [] : restsOnItems(card.restsOn, props.cards);
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b p-3" data-testid="task-header">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="min-w-0 break-words font-medium text-sm">
          {card?.task.title ?? props.task.title}
        </h2>
        <LinkOut url={props.task.ref.url}>Open on {trackerName(props.task.ref.tracker)}</LinkOut>
      </div>
      {card !== null || mapItem === null ? null : (
        <>
          <StatusMark status={mapItem.status} />
          <p className="break-words text-muted-foreground text-xs" data-testid="task-status-why">
            {mapItem.statusWhy}
          </p>
        </>
      )}
      {card === null ? null : (
        <>
          <StatusMark status={card.status} />
          <p className="break-words text-muted-foreground text-xs" data-testid="task-status-why">
            {card.statusWhy}
          </p>
          {props.leases ? <LeaseChipView lease={card.lease} nowMs={nowMs} /> : null}
          {pr === null ? null : (
            <Row label="Pull request">
              <span>{pr}</span>
              <LinkOut url={card.pr?.url}>Open</LinkOut>
            </Row>
          )}
          {preview === undefined ? null : (
            <Row label="Preview">
              <span data-preview={preview.state}>{previewStateLabel(preview.state)}</span>
              <LinkOut url={preview.url}>Open preview</LinkOut>
            </Row>
          )}
          {restsOn.length === 0 ? null : (
            <Row label="Rests on">
              {restsOn.map((item, index) => (
                <span key={item.id} data-rests-on={item.id}>
                  {item.title ?? item.id}
                  {index < restsOn.length - 1 ? "," : ""}
                </span>
              ))}
            </Row>
          )}
        </>
      )}
      <CheckedSection checked={relayTask?.checked} signOff={props.signOff} task={props.task} />
      {props.note === null ? null : (
        <p className="text-muted-foreground text-xs" role="status">
          {props.note}
        </p>
      )}
    </header>
  );
}

/**
 * Upstream's issue thread and composer for the task, when this environment can read issues and one of
 * its projects is on the task's tracker and scope. Comments post on the person's own login.
 */
function TaskThread(props: {
  readonly environmentId: EnvironmentId;
  readonly task: BanneretBoardTask;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { environmentId, task } = props;
  const issuesSupported =
    useServerConfigs().get(environmentId)?.environment.capabilities.issues === true;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  // Only a standalone tracker's link asks for its bindings, whose read probes the tracker.
  const trackers =
    useEnvironmentQuery(
      issuesSupported && mayContainStandaloneIssueLink(task.ref.url)
        ? issueTrackerEnvironment.connections({ environmentId, input: {} })
        : null,
    ).data ?? undefined;
  const target = issuesSupported
    ? resolveIssueLinkTarget({ url: task.ref.url, projects, trackers })
    : null;
  const matches =
    target !== null &&
    target.ref.tracker === task.ref.tracker &&
    target.ref.key.toLowerCase() === task.ref.key.toLowerCase();
  if (!matches) {
    const name = trackerName(task.ref.tracker);
    return (
      <p className="p-3 text-muted-foreground text-xs" data-testid="task-link-out">
        The thread shows here when a project on this machine uses {name} for {task.ref.scope}.
      </p>
    );
  }
  const { threadRef } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="task-thread" data-task-thread>
      <p className="px-3 pt-2 text-muted-foreground text-xs" data-testid="task-thread-help">
        Edits here are made on {trackerName(task.ref.tracker)} as you; the board's rules for claims
        and sign-off still apply.
      </p>
      <IssueDetailPanel
        environmentId={environmentId}
        reference={target.ref}
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
  const taskId = surface.task.id;
  const feed = useEnvironmentFeed(environmentId);
  const enrolment = useEnrolmentView(environmentId);

  // A thread's panel has no page following the feed, so the tab follows it while shown.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's relay feed while the Task tab is shown
  useEffect(() => watchFeed(environmentId), [environmentId]);

  const card = feed.board?.value?.cards.find((candidate) => candidate.task.id === taskId) ?? null;
  // The map carries every planned task, closed issues included, that the relay may not serve.
  const mapItem = feed.map?.value?.items.find((item) => item.task?.id === taskId) ?? null;
  // Only a relay that advertises the section serves the read; any other relay answers 404 for a task
  // that exists.
  const offered = feed.joined && feed.sectionsKnown && feed.sections.includes("task");
  const read = useTaskRead(environmentId, taskId, offered, feed.board?.fetchedAt ?? null);

  const answer = read.kind === "done" ? read.read : null;
  const relayTask = answer?.value ?? null;
  const shown = card ?? relayTask;
  const known = shown !== null || mapItem !== null;
  const note =
    read.kind === "loading" && !known
      ? "Loading…"
      : answer?.notFound === true && card === null
        ? "Details from the relay aren't available for this task."
        : answer?.problem !== undefined && !known
          ? answer.problem.message
          : read.kind === "done" && answer === null && !known
            ? "The task could not be read."
            : null;
  return (
    <div className="flex h-full min-h-0 flex-col" data-task-panel={surface.task.id}>
      <TaskHeader
        task={surface.task}
        card={shown}
        mapItem={mapItem}
        relayTask={relayTask}
        cards={feed.board?.value?.cards ?? []}
        leases={card === null || feed.board?.leases === true}
        signOff={enrolment?.me?.role === "founder"}
        note={note}
      />
      <TaskThread environmentId={environmentId} task={surface.task} threadRef={props.threadRef} />
    </div>
  );
}
