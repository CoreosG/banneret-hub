// Fork UI kit: a titled box of rows, with its empty state.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { RADIUS_PANEL, TEXT_SECTION, toneProps } from "./tokens";

/**
 * A section: header (icon, title, count, optional action), then its rows. `attention` adds the
 * amber bar and header icon (Stuck). Put `SectionRow`s or a `SectionEmpty` in `children`.
 */
export function Section(props: {
  readonly title: string;
  readonly icon?: LucideIcon;
  readonly count?: number;
  readonly action?: ReactNode;
  readonly attention?: boolean;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  const Icon = props.icon;
  const attention = props.attention === true;
  return (
    <section
      aria-label={props.title}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden border bg-card",
        props.className,
      )}
      {...RADIUS_PANEL}
    >
      {attention ? (
        <span
          aria-hidden
          data-slot="attention-bar"
          className="absolute inset-y-0 left-0 w-0.75"
          {...toneProps("warn", "solid")}
        />
      ) : null}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        {Icon === undefined ? null : (
          <Icon
            aria-hidden
            className={cn("size-4 shrink-0", !attention && "text-muted-foreground")}
            {...(attention ? toneProps("warn", "fg") : {})}
          />
        )}
        <h2 className="min-w-0 truncate" {...TEXT_SECTION}>
          {props.title}
        </h2>
        {props.count === undefined ? null : (
          <span className="rounded-full bg-muted px-1.5 font-medium text-2xs text-muted-foreground tabular-nums">
            {props.count}
          </span>
        )}
        {props.action === undefined ? null : <div className="ml-auto shrink-0">{props.action}</div>}
      </header>
      <div className="flex flex-col p-1">{props.children}</div>
    </section>
  );
}

/** One row. With `onSelect` it is a button; otherwise a plain row that can hold its own links. */
export function SectionRow(props: {
  readonly children: ReactNode;
  readonly onSelect?: (() => void) | undefined;
  readonly className?: string;
}) {
  const className = cn(
    "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent",
    props.onSelect !== undefined &&
      "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    props.className,
  );
  if (props.onSelect === undefined) {
    return (
      <div className={className} data-slot="section-row">
        {props.children}
      </div>
    );
  }
  return (
    <button type="button" className={className} data-slot="section-row" onClick={props.onSelect}>
      {props.children}
    </button>
  );
}

/** The empty state inside a box: an icon tile, one line of fact, one line of what will appear. */
export function SectionEmpty(props: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description?: string;
}) {
  const Icon = props.icon;
  return (
    <div className="flex items-center gap-3 px-3 py-4" data-slot="section-empty">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-sm">{props.title}</span>
        {props.description === undefined ? null : (
          <span className="text-muted-foreground text-xs">{props.description}</span>
        )}
      </div>
    </div>
  );
}
