// Banneret Hub: the build map from the relay's snapshot `map` file: List, Stages and, when the map
// section flags `rests_on`, Neighbourhood. The relay computes every status and counter; this page
// only draws them. Picking an item opens its neighbourhood, else its task. The view, its stage or
// item and the List filter (`q`) live in the URL.
import type { BanneretMap, BanneretMapItem } from "@t3tools/contracts";
import { CheckIcon, XIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { isElectron } from "../env";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { mapItemText, matchesText, queryFromUrl } from "./boards.logic";
import { FeedStatus } from "./FeedParts";
import {
  blockedByLabel,
  mapNotMeasured,
  mapStages,
  spineStates,
  stageProgress,
  type MapStageView,
  type SpineState,
} from "./map.logic";
import { mapViewFromUrl, mapViewPatch, type MapView, type MapViewState } from "./mapGraph.logic";
import { defaultCentre, NeighbourhoodView } from "./MapNeighbourhoodView";
import { StageBubbles } from "./MapStagesView";
import { notMeasuredReason, offersSection } from "./relayFeed.logic";
import { MapItemCard } from "./ui/MapItemCard";
import { PageHeader, SummaryFigure } from "./ui/PageHeader";
import { QuietLine } from "./ui/QuietLine";
import { RelativeTime } from "./ui/RelativeTime";
import { legendStatuses } from "./ui/status";
import { StatusLegend } from "./ui/StatusLegend";
import {
  LAYOUT_MAP_STAGE,
  LAYOUT_MAP_STAGES,
  LAYOUT_PAGE,
  LAYOUT_PROGRESS_BAR,
  RADIUS_PANEL,
  TYPE,
} from "./ui/tokens";
import { FilterBox } from "./ui/FilterBox";
import { rememberFilters } from "./filterMemory";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { useOpenTask } from "./useOpenTask";
import { useUrlSearch } from "./useUrlSearch";

/** What picking an item does; undefined leaves it inert. */
type PickItem = (item: BanneretMapItem) => (() => void) | undefined;

const PLAN_REASONS: Readonly<Record<string, string>> = {
  malformed: "the build plan breaks a rule",
  unreachable: "the build plan file could not be read",
};
const planReason = (reason: string) => PLAN_REASONS[reason] ?? notMeasuredReason(reason);

const isAtWork = (item: BanneretMapItem, atWork: ReadonlySet<string>) =>
  item.task !== undefined && atWork.has(item.task.id);

/** One item as a compact card. A blocked item names what blocks it; the relay's reason is the tooltip. */
function MapItem(props: {
  readonly map: BanneretMap;
  readonly item: BanneretMapItem;
  readonly atWork: ReadonlySet<string>;
  readonly onPick: PickItem;
}) {
  const { item } = props;
  const { task } = item;
  const blockedBy = blockedByLabel(props.map, item);
  return (
    <li
      className="min-w-0 max-w-full"
      data-item-id={item.id}
      data-at-work={isAtWork(item, props.atWork) ? "" : undefined}
      data-blocked-by={blockedBy === null ? undefined : item.blockedBy[0]}
    >
      <MapItemCard
        title={item.title}
        status={item.status}
        number={task?.ref.key}
        why={item.statusWhy}
        note={blockedBy ?? undefined}
        atWork={isAtWork(item, props.atWork)}
        onBoard={task !== undefined}
        onOpen={props.onPick(item)}
      />
    </li>
  );
}

function StageRow(props: {
  readonly map: BanneretMap;
  readonly stage: MapStageView;
  readonly spine: SpineState;
  readonly atWork: ReadonlySet<string>;
  readonly onPick: PickItem;
}) {
  const { stage } = props;
  const { built, total } = stageProgress(stage.counts);
  const quiet = props.spine === "todo";
  return (
    <li
      aria-label={stage.title}
      data-stage-id={stage.id}
      data-spine={props.spine}
      {...LAYOUT_MAP_STAGE}
    >
      {props.spine === "ahead" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label="Built ahead of an earlier stage"
                data-slot="spine-node"
              />
            }
          >
            <CheckIcon aria-hidden className="size-2.5" strokeWidth={3.5} />
          </TooltipTrigger>
          <TooltipPopup>Built ahead of an earlier stage</TooltipPopup>
        </Tooltip>
      ) : (
        <span aria-hidden data-slot="spine-node">
          {props.spine === "done" ? <CheckIcon className="size-2.5" strokeWidth={3.5} /> : null}
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-1 pt-0.5">
        <h2 className={quiet ? "text-muted-foreground text-sm" : TYPE.cardTitle}>{stage.title}</h2>
        {total === 0 ? (
          <span className={TYPE.meta}>Nothing to build</span>
        ) : (
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              {...LAYOUT_PROGRESS_BAR}
              style={{ "--progress": built / total } as CSSProperties}
            />
            <span data-progress className={`${TYPE.meta} tabular-nums`}>
              {built}/{total} built
            </span>
          </span>
        )}
      </div>
      {stage.items.length === 0 ? (
        <p className={`${TYPE.meta} self-center`}>Nothing planned in this stage.</p>
      ) : (
        <ul className="flex min-w-0 flex-wrap content-start gap-2">
          {stage.items.map((item) => (
            <MapItem
              key={item.id}
              map={props.map}
              item={item}
              atWork={props.atWork}
              onPick={props.onPick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function BuildMapView(props: {
  readonly map: BanneretMap;
  readonly atWork: ReadonlySet<string>;
  readonly onPick: PickItem;
  readonly query: string;
}) {
  const all = mapStages(props.map);
  // The spine and progress keep every item; a filter only hides items and the stages left empty.
  const spine = spineStates(all.map((stage) => stageProgress(stage.counts)));
  const shown = all
    .map((stage, index) => ({
      stage: {
        ...stage,
        items: stage.items.filter((item) => matchesText(props.query, mapItemText(item))),
      },
      spine: spine[index]!,
    }))
    .filter((entry) => props.query === "" || entry.stage.items.length > 0);
  if (shown.length === 0) {
    return <QuietLine fact="Nothing on the map matches this filter." />;
  }
  return (
    <ol aria-label="Stages" {...LAYOUT_MAP_STAGES}>
      {shown.map(({ stage, spine: state }) => (
        <StageRow
          key={stage.id}
          map={props.map}
          stage={stage}
          spine={state}
          atWork={props.atWork}
          onPick={props.onPick}
        />
      ))}
    </ol>
  );
}

/** The stage a bubble expands to: its items, each opening its neighbourhood or its task. */
function StagePanel(props: {
  readonly map: BanneretMap;
  readonly stage: MapStageView;
  readonly atWork: ReadonlySet<string>;
  readonly onPick: PickItem;
  readonly onClose: () => void;
}) {
  const { stage } = props;
  const { built, total } = stageProgress(stage.counts);
  return (
    <section
      aria-label={stage.title}
      data-stage-panel={stage.id}
      className="flex flex-col gap-3 border bg-card p-4"
      {...RADIUS_PANEL}
    >
      <div className="flex items-center gap-3">
        <h2 className={TYPE.cardTitle}>{stage.title}</h2>
        <span className={`${TYPE.meta} tabular-nums`}>
          {total === 0 ? "Nothing to build" : `${built}/${total} built`}
        </span>
        <span className="flex-1" />
        <Button variant="ghost" size="icon-sm" aria-label="Close stage" onClick={props.onClose}>
          <XIcon aria-hidden />
        </Button>
      </div>
      {stage.items.length === 0 ? (
        <p className={TYPE.meta}>Nothing planned in this stage.</p>
      ) : (
        <ul className="flex min-w-0 flex-wrap content-start gap-2">
          {stage.items.map((item) => (
            <MapItem
              key={item.id}
              map={props.map}
              item={item}
              atWork={props.atWork}
              onPick={props.onPick}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Why the plan could not be used: the relay's reason and its sentence, as plain text. */
function NotMeasuredNote(props: { readonly map: BanneretMap }) {
  return (
    <div
      role="note"
      data-testid="map-not-measured"
      className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs"
    >
      <p className="font-semibold text-foreground">
        The build plan could not be used, so the map is not measured.
      </p>
      <ul>
        {props.map.notMeasured.map((line) => (
          <li key={`${line.source}:${line.reason}:${line.since}`}>
            <span>{planReason(line.reason)}</span> <RelativeTime at={line.since} kind="duration" />
            {line.detail === undefined ? null : (
              <>
                : <span data-detail>{line.detail}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A readable page under the workspace header; the page scrolls, the header stays. */
function MapFrame(props: { readonly company?: string; readonly children: ReactNode }) {
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
          <span className="font-medium">Build map</span>
        </span>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full flex-col gap-4 px-6 pt-6 pb-8" {...LAYOUT_PAGE}>
          {props.children}
        </div>
      </ScrollArea>
    </SidebarInset>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function mapSummary(map: BanneretMap, stageCount: number): ReactNode {
  const counts = map.counters.byStatus;
  const built = (counts.built ?? 0) + (counts.checked ?? 0);
  const blocked = counts.blocked ?? 0;
  return (
    <>
      <SummaryFigure>{plural(map.items.length, "item", "items")}</SummaryFigure> in{" "}
      {plural(stageCount, "stage", "stages")} · {built} built
      {blocked > 0 ? ` · ${blocked} blocked` : null}
    </>
  );
}

const VIEW_LABELS: Readonly<Record<MapView, string>> = {
  list: "List",
  stages: "Stages",
  neighbourhood: "Neighbourhood",
};

export function MapPage() {
  const enterprise = useEnterpriseFeed();
  const openTask = useOpenTask(enterprise?.target ?? null);
  const [rawSearch, setSearch] = useUrlSearch();
  const query = queryFromUrl(rawSearch);
  const state = mapViewFromUrl(rawSearch);
  const motion = !useMediaQuery("(prefers-reduced-motion: reduce)");
  const updateMap = (next: MapViewState, q: string, replace = false) => {
    const params = { ...mapViewPatch(next), q: q || undefined };
    if (enterprise) rememberFilters(enterprise.workspace.id, "map", params);
    setSearch(params, { replace });
  };
  const go = (patch: Partial<MapViewState>, replace = false) =>
    updateMap({ ...state, ...patch }, query, replace);
  if (enterprise === null) {
    return (
      <MapFrame>
        <PageHeader title="Build map" />
        <QuietLine
          fact="No company here yet."
          hint="Choose an Enterprise workspace that this machine has joined to see its company here."
        />
      </MapFrame>
    );
  }
  const { feed, workspace } = enterprise;
  if (!offersSection(feed, "map")) {
    return (
      <MapFrame company={workspace.name}>
        <PageHeader title="Build map" />
        <QuietLine fact={`${workspace.name} does not offer a build map.`} />
      </MapFrame>
    );
  }
  const read = feed.map;
  const map = read?.value ?? null;
  const atWork = new Set(read?.atWork ?? []);
  const hasItems = map !== null && map.items.length > 0;
  const restsOnOffered = read?.restsOn === true && hasItems;
  const views: ReadonlyArray<MapView> = restsOnOffered
    ? ["list", "stages", "neighbourhood"]
    : ["list", "stages"];
  const active: MapView = hasItems && views.includes(state.view) ? state.view : "list";
  // Picking an item opens its neighbourhood when the relay offers one; otherwise only a task opens.
  const pickItem: PickItem = (item) => {
    if (restsOnOffered)
      return () => go({ view: "neighbourhood", item: item.id, open: [], all: false });
    const { task } = item;
    return task === undefined ? undefined : () => openTask(task);
  };

  let body: ReactNode;
  if (map === null) {
    body = read?.problem === undefined && !feed.unreachable ? <QuietLine fact="Loading…" /> : null;
  } else if (map.items.length === 0) {
    // A broken plan is never shown as an empty one.
    body = mapNotMeasured(map) ? (
      <NotMeasuredNote map={map} />
    ) : (
      <QuietLine
        fact="This relay has no build plan yet."
        hint="Its stages appear here once the company adds a stage plan."
      />
    );
  } else {
    const statuses = legendStatuses(map.counters.byStatus).filter(
      (status) => read?.checked === true || status !== "checked",
    );
    let view: ReactNode;
    if (active === "neighbourhood") {
      const centre = map.items.find((item) => item.id === state.item) ?? defaultCentre(map);
      view = (
        <NeighbourhoodView
          map={map}
          centre={centre}
          open={state.open}
          showAll={state.all}
          atWork={atWork}
          motion={motion}
          onOpenTask={openTask}
          onCentre={(id) => go({ item: id, open: [], all: false })}
          onToggleOpen={(id) =>
            go(
              {
                item: centre.id,
                open: state.open.includes(id)
                  ? state.open.filter((other) => other !== id)
                  : [...state.open, id],
              },
              true,
            )
          }
          onShowAll={(all) => go({ item: centre.id, all }, true)}
        />
      );
    } else if (active === "stages") {
      const stage = mapStages(map).find((entry) => entry.id === state.stage) ?? null;
      view = (
        <div className="flex flex-col gap-4">
          {stage === null ? (
            <p className={TYPE.meta}>
              Bubbles follow the plan order. Size is the item count; the ring and dots show status.
              Select a stage to see its items.
            </p>
          ) : (
            <StagePanel
              map={map}
              stage={stage}
              atWork={atWork}
              onPick={pickItem}
              onClose={() => go({ stage: null }, true)}
            />
          )}
          <StageBubbles
            map={map}
            selected={stage?.id ?? null}
            motion={motion}
            onSelect={(id) => go({ stage: id }, true)}
          />
        </div>
      );
    } else {
      view = <BuildMapView map={map} atWork={atWork} onPick={pickItem} query={query} />;
    }
    body = (
      <>
        {mapNotMeasured(map) ? <NotMeasuredNote map={map} /> : null}
        <StatusLegend
          counts={map.counters.byStatus}
          statuses={statuses}
          atWorkCount={map.items.filter((item) => isAtWork(item, atWork)).length}
        />
        {view}
      </>
    );
  }

  return (
    <MapFrame company={workspace.name}>
      <PageHeader
        title="Build map"
        summary={hasItems ? mapSummary(map, mapStages(map).length) : undefined}
      >
        {hasItems && active === "list" ? (
          <FilterBox
            label="Filter the map"
            placeholder="Filter the map"
            value={query}
            onChange={(q) => updateMap(state, q, true)}
          />
        ) : null}
        {hasItems ? (
          <ToggleGroup
            aria-label="Map views"
            variant="segmented"
            value={[active]}
            onValueChange={(value) => {
              const next = views.find((view) => view === value[0]);
              if (next !== undefined) go({ view: next });
            }}
          >
            {views.map((view) => (
              <Toggle key={view} value={view}>
                {VIEW_LABELS[view]}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
      </PageHeader>
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={read?.fetchedAt ?? null}
        problem={read?.problem ?? null}
      />
      {body}
    </MapFrame>
  );
}
