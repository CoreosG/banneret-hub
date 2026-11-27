// Banneret Hub: the Map's Stages view. Each stage is a bubble in plan order: its size follows the item
// count, its ring the status mix and its dots the items. A faint line joins stages that rest on each
// other, amber while something blocks. Clicking a bubble expands that stage below the canvas.
import type { BanneretMap } from "@t3tools/contracts";
import { useState, type KeyboardEvent } from "react";

import { arcPath, stageLayout, type StageBubble } from "./mapGraph.logic";
import { statusView } from "./ui/status";
import { LAYOUT_STAGE_BUBBLES, toneProps } from "./ui/tokens";

const toneOf = (status: string) => statusView(status).tone ?? "muted";

/** What a screen reader hears for one bubble: its place, name, size and status mix. */
function bubbleLabel(bubble: StageBubble): string {
  if (bubble.count === 0) return `Stage ${bubble.number}, ${bubble.title}: nothing planned`;
  const mix = Object.entries(bubble.counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${statusView(status).label.toLowerCase()}`)
    .join(", ");
  const items = bubble.count === 1 ? "1 item" : `${bubble.count} items`;
  return `Stage ${bubble.number}, ${bubble.title}: ${items}, ${bubble.built} of ${bubble.total} built. ${mix}`;
}

function Bubble(props: {
  readonly bubble: StageBubble;
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly onHint: (title: string | null) => void;
}) {
  const { bubble } = props;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onToggle();
  };
  const ringRadius = bubble.r - 3;
  const gap = bubble.ring.length > 1 ? 0.004 : 0;
  const labelY = bubble.labelInside ? 9 : bubble.r + 18;
  const metaY = bubble.r + 18 + (bubble.labelInside ? 0 : bubble.labelLines.length * 16);
  return (
    <g
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      aria-label={bubbleLabel(bubble)}
      data-slot="stage-bubble"
      data-stage-id={bubble.id}
      data-spine={bubble.spine}
      transform={`translate(${bubble.x} ${bubble.y})`}
      onFocus={() => props.onHint(bubble.title)}
      onBlur={() => props.onHint(null)}
      onMouseEnter={() => props.onHint(bubble.title)}
      onMouseLeave={() => props.onHint(null)}
      onClick={props.onToggle}
      onKeyDown={onKeyDown}
    >
      <title>{bubble.title}</title>
      {bubble.spine === "current" ? <circle r={bubble.r + 6} data-slot="bubble-halo" /> : null}
      <circle r={bubble.r} data-slot="bubble-hull" />
      {bubble.ring.map((segment) => (
        <path
          key={segment.status}
          d={arcPath(ringRadius, segment.from + gap, segment.to - gap)}
          data-slot="bubble-ring"
          data-status={segment.status}
          data-count={segment.count}
          {...toneProps(toneOf(segment.status), "stroke")}
        />
      ))}
      <g
        aria-hidden
        transform={bubble.labelInside ? `translate(0 ${-bubble.r * 0.47}) scale(0.5)` : undefined}
      >
        {bubble.dots.map((dot) => (
          <circle
            key={dot.itemId}
            cx={dot.x}
            cy={dot.y}
            r={bubble.dotRadius}
            data-slot="bubble-dot"
            data-item-id={dot.itemId}
            data-status={dot.status}
            {...toneProps(toneOf(dot.status), "fill")}
          />
        ))}
      </g>
      <text className="font-mono" textAnchor="middle" data-slot="bubble-title" aria-hidden>
        {bubble.labelLines.map((line, index) => {
          const y = labelY + index * 16;
          return (
            <tspan key={y} x={0} y={y}>
              {line}
            </tspan>
          );
        })}
      </text>
      <text y={metaY} textAnchor="middle" data-slot="bubble-meta" aria-hidden>
        {bubble.count === 0 ? "Nothing planned" : `${bubble.built}/${bubble.total} built`}
      </text>
    </g>
  );
}

export function StageBubbles(props: {
  readonly map: BanneretMap;
  readonly selected: string | null;
  readonly motion: boolean;
  readonly onSelect: (stageId: string | null) => void;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const layout = stageLayout(props.map);
  const selected = layout.bubbles.some((bubble) => bubble.id === props.selected)
    ? props.selected
    : null;
  const spineState = new Map(layout.bubbles.map((bubble) => [bubble.id, bubble.spine] as const));
  return (
    <>
      <div className="relative">
        {hint && (
          <span
            role="tooltip"
            className="pointer-events-none absolute top-1 left-1 rounded bg-popover px-2 py-1 text-sm text-popover-foreground shadow"
          >
            {hint}
          </span>
        )}
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="Stages in plan order"
          data-has-selection={selected === null ? undefined : ""}
          data-motion={props.motion ? "on" : "off"}
          {...LAYOUT_STAGE_BUBBLES}
        >
          <g aria-hidden>
            {layout.spine.map((link) => (
              <path
                key={`${link.from}>${link.to}`}
                d={link.path}
                data-slot="stage-spine"
                data-spine={
                  spineState.get(link.from) === "done" && spineState.get(link.to) === "done"
                    ? "done"
                    : undefined
                }
              />
            ))}
            {layout.bundles.map((bundle) => (
              <path
                key={`${bundle.from}>${bundle.to}`}
                d={bundle.path}
                strokeWidth={Math.min(10, 1 + Math.sqrt(bundle.count) * 1.4)}
                data-slot="stage-bundle"
                data-from={bundle.from}
                data-to={bundle.to}
                data-blocking={bundle.blocking > 0 ? "" : undefined}
                data-near={
                  selected !== null && (bundle.from === selected || bundle.to === selected)
                    ? ""
                    : undefined
                }
              />
            ))}
          </g>
          {layout.bubbles.map((bubble) => (
            <Bubble
              key={bubble.id}
              bubble={bubble}
              onHint={setHint}
              selected={bubble.id === selected}
              onToggle={() => props.onSelect(bubble.id === selected ? null : bubble.id)}
            />
          ))}
        </svg>
      </div>
      <ul aria-label="Stage legend" className="grid gap-1 sm:grid-cols-2">
        {layout.bubbles.map((bubble) => (
          <li key={bubble.id}>
            <button
              type="button"
              className="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent aria-pressed:bg-accent"
              aria-pressed={bubble.id === selected}
              onClick={() => props.onSelect(bubble.id === selected ? null : bubble.id)}
            >
              {bubbleLabel(bubble)}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
