import { countLabel } from "./countLabel";
// Banneret Hub: the Map's Neighbourhood view. One item in the middle, what it rests on to the left and
// what rests on it to the right. An arrow is amber when the relay lists its blocker in `blockedBy`,
// dashed when that blocker is itself blocked. Nodes are buttons over an SVG of the arrows.
import type { BanneretBoardTask, BanneretMap, BanneretMapItem } from "@t3tools/contracts";
import { ChevronDownIcon, LocateFixedIcon, MinusIcon } from "lucide-react";
import { type CSSProperties, useId, useState } from "react";

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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { blockedByLabel } from "./map.logic";
import { COLUMN_CAP, NODE_HEIGHT, neighbourhoodLayout, type GraphNode } from "./mapGraph.logic";
import { statusView } from "./ui/status";
import { StatusIcon } from "./ui/StatusPill";
import { LAYOUT_NEIGHBOURHOOD, RADIUS_PANEL, TYPE } from "./ui/tokens";

const stageTitleOf = (map: BanneretMap, item: BanneretMapItem) =>
  map.stages.find((stage) => stage.id === item.stageId)?.title ?? "Other";

/** The default centre: the first item that rests on something, else the first item. */
export const defaultCentre = (map: BanneretMap) =>
  map.items.find((item) => item.restsOn.length > 0) ?? map.items[0]!;

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
          placeholder={`Search ${countLabel(items.length, "item")}`}
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

function nodeLabel(map: BanneretMap, node: GraphNode, atWork: boolean): string {
  const { item } = node;
  const status = blockedByLabel(map, item) ?? statusView(item.status).label;
  const place =
    node.side === "centre" ? "centre" : node.side === "up" ? "it rests on" : "rests on it";
  const action =
    item.task !== undefined ? "Opens its task" : node.side === "centre" ? "" : "Centres on it";
  return [
    `${item.title}, ${status}`,
    atWork ? "agent at work" : null,
    `${stageTitleOf(map, item)}, ${place}`,
    action === "" ? null : action,
  ]
    .filter((part) => part !== null)
    .join(". ");
}

function Node(props: {
  readonly map: BanneretMap;
  readonly node: GraphNode;
  readonly atWork: boolean;
  readonly onOpenTask: (task: BanneretBoardTask) => void;
  readonly onCentre: (id: string) => void;
  readonly onToggleOpen: (id: string) => void;
}) {
  const { node } = props;
  const { item } = node;
  const { task } = item;
  const onBoard = task !== undefined;
  const isCentre = node.side === "centre";
  const activate = () => {
    if (task !== undefined) props.onOpenTask(task);
    else if (!isCentre) props.onCentre(item.id);
  };
  const clickable = onBoard || !isCentre;
  const blockedBy = blockedByLabel(props.map, item);
  const meta = [task === undefined ? null : `#${task.ref.key}`, stageTitleOf(props.map, item)]
    .filter((part) => part !== null)
    .join(" · ");
  const outward = node.side === "up" ? `that ${item.title} rests on` : `that rest on ${item.title}`;
  return (
    <div
      data-slot="graph-node"
      data-item-id={item.id}
      data-side={node.side}
      data-status={item.status}
      data-at-work={props.atWork ? "" : undefined}
      style={{ "--x": `${node.x}px`, "--y": `${node.y}px` } as CSSProperties}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={nodeLabel(props.map, node, props.atWork)}
              aria-disabled={clickable ? undefined : true}
              onClick={clickable ? activate : undefined}
              className={cn(
                "flex h-11 w-42 flex-col justify-center gap-0.5 rounded-lg border px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                onBoard ? "bg-card" : "border-dashed bg-background text-muted-foreground",
                clickable ? "cursor-pointer hover:border-input hover:bg-accent" : "cursor-default",
                !isCentre && "pr-7",
              )}
            />
          }
        >
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            {props.atWork ? (
              <span className="mx-0.5 inline-flex shrink-0 rounded-full ring-2 ring-primary ring-offset-1 ring-offset-card">
                <StatusIcon status={item.status} />
              </span>
            ) : (
              <StatusIcon status={item.status} />
            )}
            <span data-slot="node-title" className="min-w-0 truncate font-medium">
              {item.title}
            </span>
          </span>
          <span className="min-w-0 truncate text-2xs text-muted-foreground">
            {blockedBy ?? meta}
          </span>
        </TooltipTrigger>
        <TooltipPopup>{item.statusWhy}</TooltipPopup>
      </Tooltip>
      {isCentre ? null : (
        <button
          type="button"
          data-slot="node-centre"
          aria-label={`Centre on ${item.title}`}
          onClick={() => props.onCentre(item.id)}
          className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <LocateFixedIcon aria-hidden className="size-3" />
        </button>
      )}
      {isCentre || (node.more === 0 && !node.opened) ? null : (
        <button
          type="button"
          data-slot="node-expand"
          aria-expanded={node.opened}
          aria-label={node.opened ? `Hide what is ${outward}` : `Show ${node.more} more ${outward}`}
          onClick={() => props.onToggleOpen(item.id)}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border bg-card px-1 font-medium text-2xs text-muted-foreground tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {node.opened ? <MinusIcon aria-hidden className="size-3" /> : `+${node.more}`}
        </button>
      )}
    </div>
  );
}

function EdgeKey() {
  const line = (blocking?: "root" | "chain") => (
    <svg aria-hidden viewBox="0 0 24 8" className="h-2 w-6">
      <path d="M1 4H23" data-slot="graph-edge" data-blocking={blocking} />
    </svg>
  );
  return (
    <ul
      aria-label="Arrow key"
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${TYPE.meta}`}
    >
      <li className="inline-flex items-center gap-1.5">
        {line()}
        Rests on
      </li>
      <li className="inline-flex items-center gap-1.5">
        {line("root")}
        Blocks: needs you, sent back or dropped
      </li>
      <li className="inline-flex items-center gap-1.5">
        {line("chain")}
        Blocks: blocked in turn
      </li>
    </ul>
  );
}

export function NeighbourhoodView(props: {
  readonly map: BanneretMap;
  readonly centre: BanneretMapItem;
  readonly open: ReadonlyArray<string>;
  readonly showAll: boolean;
  readonly atWork: ReadonlySet<string>;
  readonly motion: boolean;
  readonly onOpenTask: (task: BanneretBoardTask) => void;
  readonly onCentre: (id: string) => void;
  readonly onToggleOpen: (id: string) => void;
  readonly onShowAll: (all: boolean) => void;
}) {
  const { map, centre } = props;
  const arrow = useId();
  const layout = neighbourhoodLayout(map, centre.id, props.open, { showAll: props.showAll });
  const restsOn = centre.restsOn.filter((id) => map.items.some((item) => item.id === id)).length;
  const unblocks = map.items.filter((item) => item.restsOn.includes(centre.id)).length;
  const past = layout.hidden.reduce((sum, column) => sum + column.count, 0);
  const isAtWork = (item: BanneretMapItem) =>
    item.task !== undefined && props.atWork.has(item.task.id);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={TYPE.meta}>Item</span>
        <ItemPicker map={map} selected={centre} onPick={props.onCentre} />
        <span className={TYPE.meta} data-testid="neighbourhood-summary">
          {stageTitleOf(map, centre)} · rests on {restsOn} · unblocks {unblocks}
        </span>
      </div>
      <EdgeKey />
      <section
        aria-label={`Neighbourhood of ${centre.title}`}
        className="border bg-muted"
        data-motion={props.motion ? "on" : "off"}
        {...RADIUS_PANEL}
        {...LAYOUT_NEIGHBOURHOOD}
      >
        <div
          data-slot="graph-canvas"
          style={{ width: layout.width, height: Math.max(layout.height, NODE_HEIGHT) }}
        >
          <svg
            aria-hidden
            data-slot="graph-edges"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            <defs>
              {(["plain", "blocking"] as const).map((kind) => (
                <marker
                  key={kind}
                  id={`${arrow}-${kind}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path
                    d="M0,0 L8,4 L0,8 Z"
                    data-slot="graph-arrow"
                    data-blocking={kind === "blocking" ? "" : undefined}
                  />
                </marker>
              ))}
            </defs>
            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}>${edge.to}`}
                d={edge.path}
                data-slot="graph-edge"
                data-from={edge.from}
                data-to={edge.to}
                data-blocking={edge.blocking ?? undefined}
                markerEnd={`url(#${arrow}-${edge.blocking === null ? "plain" : "blocking"})`}
              />
            ))}
          </svg>
          {layout.nodes.map((node) => (
            <Node
              key={node.id}
              map={map}
              node={node}
              atWork={isAtWork(node.item)}
              onOpenTask={props.onOpenTask}
              onCentre={props.onCentre}
              onToggleOpen={props.onToggleOpen}
            />
          ))}
        </div>
      </section>
      {layout.nodes.length === 1 ? (
        <p className={TYPE.meta}>{centre.title} rests on nothing and nothing rests on it.</p>
      ) : null}
      {past === 0 ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <span className={TYPE.meta}>
            {props.showAll
              ? "Every column is shown in full."
              : `Long columns show their first ${COLUMN_CAP}, blockers first.`}
          </span>
          <Button variant="outline" size="sm" onClick={() => props.onShowAll(!props.showAll)}>
            {props.showAll ? "Show fewer" : `Show ${past} more`}
          </Button>
        </div>
      )}
    </div>
  );
}
