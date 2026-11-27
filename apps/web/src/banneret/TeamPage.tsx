// Banneret Hub: the Team page. One row per person (role, machines, held leases, live agents by state);
// expanding one shows the working tree. Drawn from the relay's `team` file and the boards and map the
// feed holds. Resource cards join host pressure from the pool with the owner's linked Hub. URL: `q` filters, `person`
// expands.
import { MachineResources, usePoolResources } from "./ui/MachineResources";
import type { RelayTarget } from "./enrolmentStore";
import type { PoolResources, BanneretBoardTask, BanneretTeamMachine } from "@t3tools/contracts";
import { ChevronRightIcon, UsersIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { queryFromUrl } from "./boards.logic";
import { FeedStatus } from "./FeedParts";
import { offersSection } from "./relayFeed.logic";
import {
  filterPeople,
  type PersonRow,
  personRows,
  providerLabel,
  type SessionNode,
  sessionStateLabel,
  sessionTone,
  TEAM_GROUPS,
  taskIndex,
  totalCounts,
} from "./team.logic";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { LeaseChip } from "./ui/Chips";
import { FilterBox } from "./ui/FilterBox";
import { PageHeader, SummaryFigure } from "./ui/PageHeader";
import { QuietLine } from "./ui/QuietLine";
import { RelativeTime } from "./ui/RelativeTime";
import { LAYOUT_PAGE, RADIUS_PANEL, TEXT_SECTION, toneProps, TYPE } from "./ui/tokens";
import { useOpenTask } from "./useOpenTask";
import { useUrlSearch } from "./useUrlSearch";

type OpenTask = (task: BanneretBoardTask) => void;

/** The page fills the window; only the people panel scrolls. */
function TeamFrame(props: { readonly company?: string; readonly children: ReactNode }) {
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
          <span className="font-medium">Team</span>
        </span>
      </WorkspacePageHeader>
      <div
        className="mx-auto flex min-h-0 w-full flex-1 flex-col gap-4 px-6 pt-6 pb-8"
        {...LAYOUT_PAGE}
      >
        {props.children}
      </div>
    </SidebarInset>
  );
}

function MachineDot(props: { readonly machine: BanneretTeamMachine }) {
  const { machine } = props;
  return (
    <span
      data-machine={machine.id}
      data-online={machine.connected ? "" : undefined}
      className="inline-flex min-w-0 items-center gap-1 text-muted-foreground text-xs"
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", !machine.connected && "border")}
        {...(machine.connected ? toneProps("ok", "solid") : toneProps("muted", "edge"))}
      />
      <span className="truncate">{machine.label}</span>
      <span className="sr-only">{machine.connected ? ", online" : ", offline"}</span>
    </span>
  );
}

/** "2 Working": one group's count. Not heard from is grey and dashed, never shown as stopped. */
function GroupPill(props: {
  readonly group: (typeof TEAM_GROUPS)[number];
  readonly count: number;
}) {
  const { group } = props;
  const unheard = group.id === "not_heard_from";
  return (
    <span
      data-group={group.id}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 font-medium text-2xs tabular-nums",
        unheard && "border border-dashed",
      )}
      {...toneProps(
        group.tone,
        ...(unheard ? (["fg", "edge"] as const) : (["tint", "fg"] as const)),
      )}
    >
      {props.count} {group.label.toLowerCase()}
    </span>
  );
}

function TaskButton(props: {
  readonly taskId: string | undefined;
  readonly tasks: ReadonlyMap<string, BanneretBoardTask>;
  readonly onOpen: OpenTask;
}) {
  if (props.taskId === undefined) {
    return <span className="text-muted-foreground">no task linked</span>;
  }
  const task = props.tasks.get(props.taskId);
  if (task === undefined) {
    return <span className="text-muted-foreground">a task not on the board</span>;
  }
  return (
    <button
      type="button"
      data-task-link={task.id}
      className="min-w-0 truncate text-start text-foreground hover:underline"
      onClick={() => props.onOpen(task)}
    >
      {task.title}
    </button>
  );
}

/** One session and the helpers under it. */
function SessionLine(props: {
  readonly node: SessionNode;
  readonly row: PersonRow;
  readonly tasks: ReadonlyMap<string, BanneretBoardTask>;
  readonly onOpen: OpenTask;
  readonly depth: number;
}) {
  const { node, row } = props;
  const { session } = node;
  const machine = row.person.machines.find((candidate) => candidate.id === session.machineId);
  const helper = props.depth > 0;
  return (
    <li data-session={session.id} data-state={session.state} className="min-w-0">
      <div
        className="flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-sm hover:bg-accent"
        style={{ paddingLeft: `${8 + props.depth * 20}px` }}
      >
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            session.state === "not_heard_from" && "border border-dashed",
          )}
          {...(session.state === "not_heard_from"
            ? toneProps("muted", "edge")
            : toneProps(sessionTone(session.state, row.mine), "solid"))}
        />
        <span className="shrink-0 text-muted-foreground">
          {helper ? "Helper" : "Agent"} · {providerLabel(session.provider)}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <TaskButton taskId={session.taskId} tasks={props.tasks} onOpen={props.onOpen} />
        </span>
        <span className={cn(TYPE.meta, "shrink-0 whitespace-nowrap")}>
          {machine?.label ?? "a private machine"} · {sessionStateLabel(session)}{" "}
          <RelativeTime at={session.since} kind="duration" />
        </span>
      </div>
      {node.children.length === 0 ? null : (
        <ul aria-label={`Helpers of this ${providerLabel(session.provider)} agent`}>
          {node.children.map((child) => (
            <SessionLine
              key={child.session.id}
              node={child}
              row={row}
              tasks={props.tasks}
              onOpen={props.onOpen}
              depth={props.depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function PersonLine(props: {
  readonly target: RelayTarget;
  readonly pool: PoolResources | null;
  readonly row: PersonRow;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly tasks: ReadonlyMap<string, BanneretBoardTask>;
  readonly onOpen: OpenTask;
}) {
  const { row, expanded } = props;
  const { person } = row;
  const itemRef = useRef<HTMLLIElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- brings a person opened from search or a link into view
  useEffect(() => {
    if (expanded) itemRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);
  const groups = TEAM_GROUPS.filter((group) => row.counts[group.id] > 0);
  const live = row.trees.length > 0;
  return (
    <li ref={itemRef} data-person={person.login} className="min-w-0 border-b last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-2.5 py-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`team-tree-${person.id}`}
          className="flex min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={props.onToggle}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-accent font-semibold text-2xs uppercase"
          >
            {[...person.login][0] ?? "?"}
          </span>
          <span className={cn(TYPE.cardTitle, "truncate")}>{person.login}</span>
          {row.mine ? <span className={TYPE.meta}>you</span> : null}
          <span className={TYPE.meta}>{row.roles}</span>
        </button>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {person.machines.length === 0 ? (
            <span className={TYPE.meta}>Not joined yet · No machines</span>
          ) : (
            person.machines.map((machine) => (
              <span className="flex flex-col" key={machine.id}>
                <MachineDot machine={machine} />
                <MachineResources
                  target={props.target}
                  machineId={machine.id}
                  hostId={machine.poolHostId}
                  owner={person.login}
                  pool={props.pool}
                />
              </span>
            ))
          )}
        </span>
        <span
          className="ml-auto flex flex-wrap items-center justify-end gap-1.5"
          role="group"
          aria-label="Live agents"
        >
          {groups.map((group) => (
            <GroupPill key={group.id} group={group} count={row.counts[group.id]} />
          ))}
          {row.idle > 0 ? <span className={TYPE.meta}>{row.idle} idle</span> : null}
          {!live ? <span className={TYPE.meta}>No live agents</span> : null}
        </span>
      </div>
      {row.leases.length === 0 ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-2.5 pb-2.5 pl-10">
          <span className={TYPE.meta}>Holds</span>
          {row.leases.map(({ card }) => (
            <button
              key={card.task.id}
              type="button"
              data-lease-task={card.task.id}
              className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-card px-1.5 py-0.5 text-xs hover:bg-accent"
              onClick={() => props.onOpen(card.task)}
            >
              <span className="min-w-0 truncate">{card.task.title}</span>
              <LeaseChip state={card.lease.state} staleAt={card.lease.staleAt} />
            </button>
          ))}
        </div>
      )}
      {!expanded ? null : (
        <div id={`team-tree-${person.id}`} className="px-2.5 pb-3 pl-8">
          {live ? (
            <ul aria-label={`Agents of ${person.login}`} className="flex flex-col">
              {row.trees.map((node) => (
                <SessionLine
                  key={node.session.id}
                  node={node}
                  row={row}
                  tasks={props.tasks}
                  onOpen={props.onOpen}
                  depth={0}
                />
              ))}
            </ul>
          ) : (
            <p className={cn(TYPE.meta, "px-2 py-1.5")}>
              No live agents. Sessions show here while {person.login}'s agents run.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

const personFromUrl = (raw: Readonly<Record<string, unknown>>) =>
  typeof raw.person === "string" ? raw.person.trim().toLowerCase() : "";

export function TeamPage() {
  const enterprise = useEnterpriseFeed();
  const pool = usePoolResources(
    enterprise?.target ?? null,
    enterprise?.feed.sections.includes("pool") ?? false,
  );
  const openTask = useOpenTask(enterprise?.target ?? null);
  const [rawSearch, setSearch] = useUrlSearch();
  if (enterprise === null) {
    return (
      <TeamFrame>
        <PageHeader title="Team" />
        <QuietLine
          fact="No company here yet."
          hint="Choose an Enterprise workspace that this machine has joined to see its company here."
        />
      </TeamFrame>
    );
  }
  const { feed, workspace, enrolment } = enterprise;
  if (!offersSection(feed, "team")) {
    return (
      <TeamFrame company={workspace.name}>
        <PageHeader title="Team" />
        <QuietLine fact={`${workspace.name} does not offer a team view.`} />
      </TeamFrame>
    );
  }
  const query = queryFromUrl(rawSearch);
  const open = personFromUrl(rawSearch);
  const read = feed.team;
  const team = read?.value ?? null;
  const rows =
    team === null
      ? []
      : personRows({ team, meLogin: enrolment.me?.login, boards: feed.board?.value });
  const tasks = taskIndex(feed.board?.value, feed.map?.value);
  const shown = filterPeople(rows, query, tasks);
  const totals = totalCounts(rows);
  const idle = rows.reduce((sum, row) => sum + row.idle, 0);
  const waiting = read?.problem === undefined && !feed.unreachable;

  let body: ReactNode;
  if (team === null) {
    body = waiting ? <p className="text-muted-foreground text-sm">Loading…</p> : null;
  } else if (rows.length === 0) {
    body = (
      <QuietLine
        icon={UsersIcon}
        fact="Nobody is here yet."
        hint={`People show here once they sign in to ${workspace.name}.`}
      />
    );
  } else {
    body = (
      <section
        aria-label="People"
        className="flex min-h-0 flex-1 flex-col overflow-hidden border bg-card"
        {...RADIUS_PANEL}
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
          <UsersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="min-w-0 truncate" {...TEXT_SECTION}>
            People
          </h2>
          <span className="rounded-full bg-muted px-1.5 font-medium text-2xs text-muted-foreground tabular-nums">
            {shown.length}
          </span>
        </header>
        {shown.length === 0 ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">No person matches this filter.</p>
        ) : (
          <ul aria-label="Team members" className="min-h-0 flex-1 overflow-y-auto">
            {shown.map((row) => {
              const login = row.person.login.toLowerCase();
              const expanded = open === login;
              return (
                <PersonLine
                  key={row.person.id}
                  target={enterprise.target}
                  pool={pool}
                  row={row}
                  expanded={expanded}
                  onToggle={() =>
                    setSearch(
                      { person: expanded ? undefined : row.person.login },
                      { replace: true },
                    )
                  }
                  tasks={tasks}
                  onOpen={openTask}
                />
              );
            })}
          </ul>
        )}
      </section>
    );
  }

  return (
    <TeamFrame company={workspace.name}>
      <PageHeader
        title="Team"
        summary={
          team === null ? undefined : (
            <>
              <SummaryFigure>{totals.working} working</SummaryFigure>
              {` · ${idle} idle`}
              {totals.needs_you > 0 ? ` · ${totals.needs_you} needs you` : null}
            </>
          )
        }
      >
        <FilterBox
          label="Find a person"
          placeholder="Find a person"
          value={query}
          onChange={(q) => setSearch({ q }, { replace: true })}
        />
      </PageHeader>
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={read?.fetchedAt ?? null}
        problem={read?.problem ?? null}
      />
      {team === null || rows.length === 0 ? null : (
        <div
          role="group"
          className="flex flex-wrap items-center gap-1.5"
          aria-label="Live agents by state"
        >
          {TEAM_GROUPS.map((group) => (
            <GroupPill key={group.id} group={group} count={totals[group.id]} />
          ))}
        </div>
      )}
      {body}
    </TeamFrame>
  );
}
