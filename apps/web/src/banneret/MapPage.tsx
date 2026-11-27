// Banneret Hub: the build map for an Enterprise workspace, drawn from the relay's snapshot `map` file,
// with a Rests-on view when the map section carries the `rests_on` flag. The relay computes every
// stage, status, reason and counter; this page only draws them. Read-only. An item with a task opens
// its Task tab; an item without one is not clickable. Relay strings render as plain text.
import type { BanneretBoardTask, BanneretMap, BanneretMapItem } from "@t3tools/contracts";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

import { isElectron } from "../env";
import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset } from "../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { taskRef } from "./board.logic";
import { FeedStatus } from "./FeedParts";
import {
  blockedByLabel,
  blockedByName,
  mapNotMeasured,
  mapStages,
  restsOnView,
  spineStates,
  stageProgress,
  type MapStageView,
  type RestsOnEntry,
  type SpineState,
} from "./map.logic";
import { notMeasuredReason, offersSection } from "./relayFeed.logic";
import { MapItemCard } from "./ui/MapItemCard";
import { PageHeader, SummaryFigure } from "./ui/PageHeader";
import { QuietLine } from "./ui/QuietLine";
import { RelativeTime } from "./ui/RelativeTime";
import { legendStatuses } from "./ui/status";
import { StatusIcon } from "./ui/StatusPill";
import { StatusLegend } from "./ui/StatusLegend";
import { TaskCard } from "./ui/TaskCard";
import {
  LAYOUT_MAP_STAGE,
  LAYOUT_MAP_STAGES,
  LAYOUT_PAGE,
  LAYOUT_PROGRESS_BAR,
  LAYOUT_RESTS_ON,
  RADIUS_PANEL,
  TYPE,
  toneProps,
} from "./ui/tokens";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { useOpenTask } from "./useOpenTask";

type View = "map" | "rests_on";
type OpenTask = (task: BanneretBoardTask) => void;

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
  readonly onOpen: OpenTask;
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
        onOpen={task === undefined ? undefined : () => props.onOpen(task)}
      />
    </li>
  );
}

function StageRow(props: {
  readonly map: BanneretMap;
  readonly stage: MapStageView;
  readonly spine: SpineState;
  readonly atWork: ReadonlySet<string>;
  readonly onOpen: OpenTask;
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
              onOpen={props.onOpen}
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
  readonly onOpen: OpenTask;
}) {
  const stages = mapStages(props.map);
  const spine = spineStates(stages.map((stage) => stageProgress(stage.counts)));
  return (
    <ol aria-label="Stages" {...LAYOUT_MAP_STAGES}>
      {stages.map((stage, index) => (
        <StageRow
          key={stage.id}
          map={props.map}
          stage={stage}
          spine={spine[index]!}
          atWork={props.atWork}
          onOpen={props.onOpen}
        />
      ))}
    </ol>
  );
}

const stageTitleOf = (map: BanneretMap, item: BanneretMapItem) =>
  map.stages.find((stage) => stage.id === item.stageId)?.title ?? "Other";

/** One card beside the picked item. A click makes it the picked item. */
function SideCard(props: {
  readonly map: BanneretMap;
  readonly entry: RestsOnEntry;
  readonly directBlocker: boolean;
  readonly atWork: ReadonlySet<string>;
  readonly onPick: (id: string) => void;
}) {
  const { entry } = props;
  if (entry.item === null) {
    return (
      <li data-item-id={entry.id}>
        <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-xs">
          {entry.id} is not on this map.
        </p>
      </li>
    );
  }
  const { item } = entry;
  const ref = item.task === undefined ? undefined : taskRef(item.task);
  return (
    <li data-item-id={item.id}>
      <TaskCard
        title={item.title}
        status={item.status}
        why={item.statusWhy}
        refLabel={ref?.repo}
        refNumber={ref?.number}
        atWork={isAtWork(item, props.atWork)}
        blockedBy={blockedByName(props.map, item) ?? undefined}
        lease={
          props.directBlocker ? (
            <span
              data-direct-blocker
              className="inline-flex h-5 items-center self-start rounded-md border px-1.5 font-medium text-2xs"
              {...toneProps("warn", "edge", "fg")}
            >
              Blocks it directly
            </span>
          ) : undefined
        }
        footer={stageTitleOf(props.map, item)}
        className={item.task === undefined ? "border-dashed" : ""}
        onOpen={() => props.onPick(item.id)}
      />
    </li>
  );
}

function SideColumn(props: {
  readonly map: BanneretMap;
  readonly label: string;
  readonly empty: string;
  readonly entries: ReadonlyArray<RestsOnEntry>;
  readonly blockers: ReadonlySet<string>;
  readonly atWork: ReadonlySet<string>;
  readonly onPick: (id: string) => void;
}) {
  return (
    <section aria-label={props.label} className="flex min-w-0 flex-col gap-2">
      <h3 className="font-medium text-2xs text-muted-foreground uppercase tracking-wider">
        {props.label} · {props.entries.length}
      </h3>
      {props.entries.length === 0 ? (
        <QuietLine fact={props.empty} />
      ) : (
        <ul className="flex flex-col gap-2">
          {props.entries.map((entry) => (
            <SideCard
              key={entry.id}
              map={props.map}
              entry={entry}
              directBlocker={props.blockers.has(entry.id)}
              atWork={props.atWork}
              onPick={props.onPick}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The item picker: a searchable list of every item, its stage as the second line. */
function ItemPicker(props: {
  readonly map: BanneretMap;
  readonly selected: BanneretMapItem;
  readonly onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const items = props.map.items;
  const filtered = items.filter((item) =>
    `${item.title} ${stageTitleOf(props.map, item)}`.toLowerCase().includes(needle),
  );
  return (
    <Combobox
      items={items}
      filteredItems={filtered}
      filter={null}
      autoHighlight
      itemToStringLabel={(item) => item.title}
      isItemEqualToValue={(a, b) => a.id === b.id}
      value={props.selected}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(item) => {
        if (item) props.onPick(item.id);
      }}
    >
      <ComboboxTrigger
        aria-label={`Item: ${props.selected.title}`}
        render={<Button variant="outline" size="sm" />}
        className="min-w-0 max-w-80"
      >
        <StatusIcon status={props.selected.status} />
        <span className="min-w-0 truncate">{props.selected.title}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-96">
        <ComboboxSearchInput
          aria-label="Search items"
          placeholder={`Search ${items.length} items`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No items match.</ComboboxEmpty>
        <ComboboxList>
          {(item: BanneretMapItem) => (
            <ComboboxItem key={item.id} value={item}>
              <StatusIcon status={item.status} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.title}</span>
                <span className="truncate text-muted-foreground text-xs">
                  {stageTitleOf(props.map, item)}
                </span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function RestsOnTab(props: {
  readonly map: BanneretMap;
  readonly atWork: ReadonlySet<string>;
  readonly onOpen: OpenTask;
}) {
  const { map } = props;
  const [chosen, setChosen] = useState<string | null>(null);
  const selected =
    map.items.find((item) => item.id === chosen) ??
    map.items.find((item) => item.restsOn.length > 0) ??
    map.items[0]!;
  const view = restsOnView(map, selected.id);
  const { task } = selected;
  const ref = task === undefined ? undefined : taskRef(task);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={TYPE.meta}>Item</span>
        <ItemPicker map={map} selected={selected} onPick={setChosen} />
        <span className={TYPE.meta}>
          {stageTitleOf(map, selected)} · rests on {view.restsOn.length} · unblocks{" "}
          {view.dependants.length}
        </span>
      </div>
      <div className="border bg-muted" {...RADIUS_PANEL} {...LAYOUT_RESTS_ON}>
        <SideColumn
          map={map}
          label="Needs these first"
          empty="Nothing. This can start now."
          entries={view.restsOn}
          blockers={new Set(selected.blockedBy)}
          atWork={props.atWork}
          onPick={setChosen}
        />
        <span aria-hidden data-slot="rests-on-arrow">
          <ArrowRightIcon className="size-4" />
        </span>
        <section aria-label="Picked item" data-item-id={selected.id}>
          <TaskCard
            title={selected.title}
            status={selected.status}
            why={selected.statusWhy}
            refLabel={ref?.repo}
            refNumber={ref?.number}
            atWork={isAtWork(selected, props.atWork)}
            blockedBy={blockedByName(map, selected) ?? undefined}
            footer={stageTitleOf(map, selected)}
            className={
              task === undefined
                ? "border-dashed p-4"
                : "border-primary p-4 ring-3 ring-primary/20 hover:border-primary"
            }
            onOpen={task === undefined ? undefined : () => props.onOpen(task)}
          />
        </section>
        <span aria-hidden data-slot="rests-on-arrow">
          <ArrowRightIcon className="size-4" />
        </span>
        <SideColumn
          map={map}
          label="Unblocks these"
          empty="Nothing waits on this."
          entries={view.dependants.map((item) => ({ id: item.id, item }))}
          blockers={new Set()}
          atWork={props.atWork}
          onPick={setChosen}
        />
      </div>
    </div>
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

export function MapPage() {
  const enterprise = useEnterpriseFeed();
  const openTask = useOpenTask(enterprise?.environmentId ?? "");
  const [view, setView] = useState<View>("map");
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
  const active: View = view === "rests_on" && restsOnOffered ? "rests_on" : "map";

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
    body = (
      <>
        {mapNotMeasured(map) ? <NotMeasuredNote map={map} /> : null}
        <StatusLegend
          counts={map.counters.byStatus}
          statuses={statuses}
          atWorkCount={map.items.filter((item) => isAtWork(item, atWork)).length}
        />
        {active === "rests_on" ? (
          <RestsOnTab map={map} atWork={atWork} onOpen={openTask} />
        ) : (
          <BuildMapView map={map} atWork={atWork} onOpen={openTask} />
        )}
      </>
    );
  }

  return (
    <MapFrame company={workspace.name}>
      <PageHeader
        title="Build map"
        summary={hasItems ? mapSummary(map, mapStages(map).length) : undefined}
      >
        {restsOnOffered ? (
          <ToggleGroup
            aria-label="Map views"
            variant="segmented"
            value={[active]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "map" || next === "rests_on") setView(next);
            }}
          >
            <Toggle value="map">Build map</Toggle>
            <Toggle value="rests_on">Rests on</Toggle>
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
