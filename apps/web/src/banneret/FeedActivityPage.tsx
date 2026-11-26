// Banneret Hub: the Feed for an Enterprise workspace, with the Graveyard as a tab, drawn from the
// relay's snapshot `feed` and `graveyard` files. Older entries load on request. Read-only: the relay
// derives every entry. Relay strings render as plain text, and only http(s) links are rendered.
import type {
  BanneretBoardTask,
  BanneretFeedEntry,
  BanneretGraveyardEntry,
  EnvironmentId,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { cleanLogin } from "./enterprise.logic";
import { Age, FeedStatus, When } from "./FeedParts";
import {
  feedTypeLabel,
  importanceOf,
  type Importance,
  mergeFeedEntries,
  mergeGraveyardEntries,
} from "./feed.logic";
import { type FeedProblem, loadOlder, olderCursor } from "./relayFeedStore";
import { offersSection, safeLinkOut } from "./relayFeed.logic";
import { StatusMark } from "./StatusLegend";
import { FeedPage, NotJoinedNote } from "./TodayPage";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { useOpenTask } from "./useOpenTask";

type Tab = "feed" | "graveyard";

const ENTRY_EMPHASIS: Record<Importance, string> = {
  high: "border-primary",
  normal: "border-transparent",
  low: "border-transparent opacity-80",
};
const SUMMARY_EMPHASIS: Record<Importance, string> = {
  high: "font-medium",
  normal: "",
  low: "text-muted-foreground",
};

function LinkOut(props: { readonly url: string | undefined }) {
  const href = safeLinkOut(props.url);
  if (href === null) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-primary hover:bg-accent"
    >
      <ExternalLinkIcon className="size-3" aria-hidden />
      Open
    </a>
  );
}

type OpenTask = (task: BanneretBoardTask) => void;

/** A task's title; a click opens its Task tab. */
function TaskLink(props: {
  readonly task: BanneretBoardTask;
  readonly onOpen: OpenTask;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      data-task-link={props.task.id}
      className={cn("break-words text-start hover:underline", props.className)}
      onClick={() => props.onOpen(props.task)}
    >
      {props.task.title}
    </button>
  );
}

function FeedEntryRow(props: { readonly entry: BanneretFeedEntry; readonly onOpenTask: OpenTask }) {
  const { entry } = props;
  const importance = importanceOf(entry.importance);
  const author = cleanLogin(entry.author?.login);
  return (
    <li
      className={cn("flex items-start gap-3 border-l-2 py-2 ps-3", ENTRY_EMPHASIS[importance])}
      data-entry-id={entry.id}
      data-type={entry.type}
      data-importance={importance}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-muted-foreground text-xs">
          {feedTypeLabel(entry.type)}
          {author === "" ? null : ` · ${author}`}
          {" · "}
          <Age at={entry.at} />
        </span>
        <span className={cn("break-words text-sm", SUMMARY_EMPHASIS[importance])}>
          {entry.summary}
        </span>
        {entry.task === undefined && entry.status === undefined ? null : (
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            {entry.status === undefined ? null : <StatusMark status={entry.status} />}
            {entry.task === undefined ? null : (
              <TaskLink task={entry.task} onOpen={props.onOpenTask} />
            )}
          </span>
        )}
      </div>
      <LinkOut url={entry.link} />
    </li>
  );
}

function GraveyardRow(props: {
  readonly entry: BanneretGraveyardEntry;
  readonly onOpenTask: OpenTask;
}) {
  const { entry } = props;
  const by = cleanLogin(entry.by?.login);
  return (
    <li className="flex items-start gap-3 py-2" data-task-id={entry.task.id}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <TaskLink task={entry.task} onOpen={props.onOpenTask} className="text-sm" />
        <span className="break-words text-sm" data-testid="graveyard-cause">
          Cause: {entry.cause}
        </span>
        <span className="text-muted-foreground text-xs">
          <StatusMark status="ruled_dead" /> <When at={entry.ruledAt} />
          {by === "" ? null : ` by ${by}`}
        </span>
      </div>
      <LinkOut url={entry.link} />
    </li>
  );
}

function LoadOlder(props: {
  readonly environmentId: EnvironmentId;
  readonly kind: "activity" | "graveyard";
  readonly more: boolean;
  readonly problem: FeedProblem | null;
}) {
  const [loading, setLoading] = useState(false);
  if (!props.more && props.problem === null) return null;
  return (
    <div className="flex flex-col items-start gap-1">
      {props.problem === null ? null : (
        <p role="alert" className="text-warning-foreground text-xs">
          Older entries could not be read. {props.problem.message}
        </p>
      )}
      {props.more ? (
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void loadOlder(props.environmentId, props.kind).finally(() => setLoading(false));
          }}
        >
          Load older
        </Button>
      ) : null}
    </div>
  );
}

function Tabs(props: { readonly active: Tab; readonly onChange: (tab: Tab) => void }) {
  const tab = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`feed-tab-${id}`}
      aria-selected={props.active === id}
      aria-controls="feed-tab-panel"
      className={cn(
        "rounded-md px-2.5 py-1 text-sm",
        props.active === id
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={() => props.onChange(id)}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Feed views" className="flex gap-1">
      {tab("feed", "Feed")}
      {tab("graveyard", "Graveyard")}
    </div>
  );
}

const Loading = () => <p className="text-muted-foreground text-sm">Loading…</p>;

export function FeedActivityPage() {
  const enterprise = useEnterpriseFeed();
  const openTask = useOpenTask(enterprise?.environmentId ?? "");
  const [tab, setTab] = useState<Tab>("feed");
  if (enterprise === null) {
    return (
      <FeedPage title="Feed">
        <NotJoinedNote />
      </FeedPage>
    );
  }
  const { environmentId, feed, workspace } = enterprise;
  if (!offersSection(feed, "feed")) {
    return (
      <FeedPage title="Feed">
        <p className="text-muted-foreground text-sm">{workspace.name} does not offer a feed.</p>
      </FeedPage>
    );
  }
  const graveyardOffered = feed.graveyard !== null;
  const active: Tab = tab === "graveyard" && graveyardOffered ? "graveyard" : "feed";
  const read = active === "feed" ? feed.activity : feed.graveyard;
  const waiting = read?.problem === undefined && !feed.unreachable;

  let body: ReactNode;
  if (active === "feed") {
    const file = feed.activity?.value ?? null;
    const entries =
      file === null ? [] : mergeFeedEntries(file.entries, feed.activityOlder?.entries ?? []);
    body =
      file === null ? (
        waiting ? (
          <Loading />
        ) : null
      ) : (
        <>
          {entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">No activity yet</p>
          ) : (
            <ul aria-label="Feed entries" className="flex flex-col divide-y rounded-lg border px-4">
              {entries.map((entry) => (
                <FeedEntryRow key={entry.id} entry={entry} onOpenTask={openTask} />
              ))}
            </ul>
          )}
          <LoadOlder
            environmentId={environmentId}
            kind="activity"
            more={olderCursor(feed, "activity") !== null}
            problem={feed.activityOlderProblem}
          />
        </>
      );
  } else {
    const file = feed.graveyard?.value ?? null;
    const entries =
      file === null ? [] : mergeGraveyardEntries(file.entries, feed.graveyardOlder?.entries ?? []);
    body =
      file === null ? (
        waiting ? (
          <Loading />
        ) : null
      ) : (
        <>
          {entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing has been ruled dead</p>
          ) : (
            <ul
              aria-label="Graveyard entries"
              className="flex flex-col divide-y rounded-lg border px-4"
            >
              {entries.map((entry) => (
                <GraveyardRow key={entry.task.id} entry={entry} onOpenTask={openTask} />
              ))}
            </ul>
          )}
          <LoadOlder
            environmentId={environmentId}
            kind="graveyard"
            more={olderCursor(feed, "graveyard") !== null}
            problem={feed.graveyardOlderProblem}
          />
        </>
      );
  }

  return (
    <FeedPage title={`Feed in ${workspace.name}`}>
      {graveyardOffered ? <Tabs active={active} onChange={setTab} /> : null}
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={read?.fetchedAt ?? null}
        problem={read?.problem ?? null}
      />
      <div
        id="feed-tab-panel"
        role={graveyardOffered ? "tabpanel" : undefined}
        aria-labelledby={graveyardOffered ? `feed-tab-${active}` : undefined}
        className="flex flex-col gap-4"
      >
        {body}
      </div>
    </FeedPage>
  );
}
