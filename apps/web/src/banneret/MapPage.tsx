// Banneret Hub: the build map for an Enterprise workspace, drawn from the relay's snapshot `map` file,
// with a Rests-on view when the map section carries the `rests_on` flag. The relay computes every
// stage, status, reason and counter; this page only draws them. Read-only. An item with a task opens
// its Task tab; an item without one is not clickable and says so. Relay strings render as plain text.
import type { BanneretBoardTask, BanneretMap, BanneretMapItem } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { cn } from "../lib/utils";
import { FeedStatus, When } from "./FeedParts";
import { mapNotMeasured, mapStages, orderedCounts, restsOnView } from "./map.logic";
import { notMeasuredReason, offersSection } from "./relayFeed.logic";
import { StatusCounts, StatusLegend, StatusMark } from "./StatusLegend";
import { FeedPage, NotJoinedNote } from "./TodayPage";
import { useEnterpriseFeed } from "./useEnterpriseFeed";
import { useOpenTask } from "./useOpenTask";

type Tab = "map" | "rests_on";
type OpenTask = (task: BanneretBoardTask) => void;

const PLAN_REASONS: Readonly<Record<string, string>> = {
  malformed: "the build plan breaks a rule",
  unreachable: "the build plan file could not be read",
};
const planReason = (reason: string) => PLAN_REASONS[reason] ?? notMeasuredReason(reason);

/** One item: its status mark and word, its title and the relay's reason. A task makes it a button. */
function MapItemView(props: {
  readonly item: BanneretMapItem;
  readonly atWork: boolean;
  readonly onOpen: OpenTask;
}) {
  const { item } = props;
  const content = (
    <>
      <StatusMark status={item.status} atWork={props.atWork} />
      <span className="break-words text-sm">{item.title}</span>
      <span data-status-why className="break-words text-muted-foreground text-xs">
        {item.statusWhy}
      </span>
    </>
  );
  const box = "flex w-full flex-col gap-1 rounded-md border p-2.5 text-start";
  const { task } = item;
  return (
    <li data-item-id={item.id} data-at-work={props.atWork ? "" : undefined}>
      {task === undefined ? (
        // Quieter than a card with a task, so it does not read as something to click.
        <div className={cn(box, "cursor-default border-dashed")}>
          {content}
          <span data-no-task className="text-muted-foreground/70 text-xs">
            No task linked
          </span>
        </div>
      ) : (
        <button
          type="button"
          data-open-task={task.id}
          className={cn(
            box,
            "cursor-pointer bg-card text-card-foreground shadow-xs/5 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          )}
          onClick={() => props.onOpen(task)}
        >
          {content}
        </button>
      )}
    </li>
  );
}

function BuildMapView(props: {
  readonly map: BanneretMap;
  readonly atWork: ReadonlySet<string>;
  readonly onOpen: OpenTask;
}) {
  return (
    <div className="flex flex-col gap-4">
      {mapStages(props.map).map((stage) => (
        <section
          key={stage.id}
          aria-label={stage.title}
          data-stage-id={stage.id}
          className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="font-medium text-sm">{stage.title}</h2>
            <StatusCounts
              label={`${stage.title} counts`}
              counts={orderedCounts(stage.counts)}
              className="ml-auto"
            />
          </div>
          {stage.items.length === 0 ? (
            <p className="text-muted-foreground text-xs">Nothing planned in this stage.</p>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
              {stage.items.map((item) => (
                <MapItemView
                  key={item.id}
                  item={item}
                  atWork={item.task !== undefined && props.atWork.has(item.task.id)}
                  onOpen={props.onOpen}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function RestsOnList(props: {
  readonly label: string;
  readonly entries: ReadonlyArray<{ readonly id: string; readonly item: BanneretMapItem | null }>;
  readonly atWork: ReadonlySet<string>;
  readonly onOpen: OpenTask;
}) {
  return (
    <section aria-label={props.label} className="flex flex-col gap-2">
      <h3 className="font-medium text-sm">{props.label}</h3>
      {props.entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">Nothing.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {props.entries.map((entry) =>
            entry.item === null ? (
              <li
                key={entry.id}
                data-item-id={entry.id}
                className="rounded-md border border-dashed p-2.5 text-muted-foreground text-xs"
              >
                {entry.id} is not on this map.
              </li>
            ) : (
              <MapItemView
                key={entry.id}
                item={entry.item}
                atWork={entry.item.task !== undefined && props.atWork.has(entry.item.task.id)}
                onOpen={props.onOpen}
              />
            ),
          )}
        </ul>
      )}
    </section>
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
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Item</span>
        <select
          className="h-8 max-w-md rounded-md border bg-background px-2 text-sm"
          value={selected.id}
          onChange={(event) => setChosen(event.target.value)}
        >
          {map.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </label>
      <ul aria-label="Selected item" className="max-w-md">
        <MapItemView
          item={selected}
          atWork={selected.task !== undefined && props.atWork.has(selected.task.id)}
          onOpen={props.onOpen}
        />
      </ul>
      <div className="grid gap-4 md:grid-cols-2">
        <RestsOnList
          label="It rests on"
          entries={view.restsOn}
          atWork={props.atWork}
          onOpen={props.onOpen}
        />
        <RestsOnList
          label="Rests on it"
          entries={view.dependants.map((item) => ({ id: item.id, item }))}
          atWork={props.atWork}
          onOpen={props.onOpen}
        />
      </div>
    </div>
  );
}

function Tabs(props: { readonly active: Tab; readonly onChange: (tab: Tab) => void }) {
  const tab = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`map-tab-${id}`}
      aria-selected={props.active === id}
      aria-controls="map-tab-panel"
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
    <div role="tablist" aria-label="Map views" className="flex gap-1">
      {tab("map", "Build map")}
      {tab("rests_on", "Rests on")}
    </div>
  );
}

/** Why the plan could not be used: the relay's reason and its sentence, as plain text. */
function NotMeasuredNote(props: { readonly map: BanneretMap }) {
  return (
    <div
      role="note"
      data-testid="map-not-measured"
      className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-muted-foreground text-xs"
    >
      <p>The build plan could not be used, so the map is not measured.</p>
      <ul className="flex flex-col gap-1">
        {props.map.notMeasured.map((line) => (
          <li key={`${line.source}:${line.reason}:${line.since}`}>
            <span>{planReason(line.reason)}</span> since <When at={line.since} />
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

export function MapPage() {
  const enterprise = useEnterpriseFeed();
  const openTask = useOpenTask(enterprise?.environmentId ?? "");
  const [tab, setTab] = useState<Tab>("map");
  if (enterprise === null) {
    return (
      <FeedPage title="Map">
        <NotJoinedNote />
      </FeedPage>
    );
  }
  const { feed, workspace } = enterprise;
  if (!offersSection(feed, "map")) {
    return (
      <FeedPage title="Map">
        <p className="text-muted-foreground text-sm">
          {workspace.name} does not offer a build map.
        </p>
      </FeedPage>
    );
  }
  const read = feed.map;
  const map = read?.value ?? null;
  const atWork = new Set(read?.atWork ?? []);
  const restsOnOffered = read?.restsOn === true && map !== null && map.items.length > 0;
  const active: Tab = tab === "rests_on" && restsOnOffered ? "rests_on" : "map";

  let body: ReactNode;
  if (map === null) {
    body =
      read?.problem === undefined && !feed.unreachable ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : null;
  } else if (map.items.length === 0) {
    // A broken plan is never shown as an empty one.
    body = mapNotMeasured(map) ? (
      <NotMeasuredNote map={map} />
    ) : (
      <p className="text-muted-foreground text-sm">This relay has no build plan yet.</p>
    );
  } else {
    body = (
      <>
        {mapNotMeasured(map) ? <NotMeasuredNote map={map} /> : null}
        <StatusLegend checked={read?.checked === true} counts={map.counters.byStatus} />
        {active === "rests_on" ? (
          <RestsOnTab map={map} atWork={atWork} onOpen={openTask} />
        ) : (
          <BuildMapView map={map} atWork={atWork} onOpen={openTask} />
        )}
      </>
    );
  }

  return (
    <FeedPage title={`Build map in ${workspace.name}`}>
      {restsOnOffered ? <Tabs active={active} onChange={setTab} /> : null}
      <FeedStatus
        feed={feed}
        company={workspace.name}
        fetchedAt={read?.fetchedAt ?? null}
        problem={read?.problem ?? null}
      />
      <div
        id="map-tab-panel"
        role={restsOnOffered ? "tabpanel" : undefined}
        aria-labelledby={restsOnOffered ? `map-tab-${active}` : undefined}
        className="flex flex-col gap-4"
      >
        {body}
      </div>
    </FeedPage>
  );
}
