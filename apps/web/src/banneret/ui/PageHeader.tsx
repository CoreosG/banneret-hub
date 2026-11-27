// Fork UI kit: a page header. Title, a one-line summary, actions on the right.
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { TEXT_SUMMARY, TYPE } from "./tokens";

/**
 * `summary` is one muted line; wrap its key number in `SummaryFigure`. `children` are the actions,
 * bottom-aligned on the right: a `ToggleGroup` first, then outline `sm` `Button`s.
 */
export function PageHeader(props: {
  readonly title: string;
  readonly summary?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-4", props.className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className={TYPE.pageTitle}>{props.title}</h1>
        {props.summary === undefined ? null : (
          <p className="text-muted-foreground" {...TEXT_SUMMARY}>
            {props.summary}
          </p>
        )}
      </div>
      {props.children === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{props.children}</div>
      )}
    </header>
  );
}

/** The key number inside a summary line. */
export function SummaryFigure(props: { readonly children: ReactNode }) {
  return <span className="font-medium text-foreground tabular-nums">{props.children}</span>;
}
