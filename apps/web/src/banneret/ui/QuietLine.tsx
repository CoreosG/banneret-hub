// Fork UI kit: an empty section collapsed to one dashed line.
import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";

/** "Nothing stuck. Stuck items appear here." with `fact` in bold. */
export function QuietLine(props: {
  readonly fact: string;
  readonly hint?: string;
  readonly icon?: LucideIcon;
  readonly className?: string;
}) {
  const Icon = props.icon;
  return (
    <p
      data-slot="quiet-line"
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs",
        props.className,
      )}
    >
      {Icon === undefined ? null : <Icon aria-hidden className="size-3.5 shrink-0" />}
      <span className="min-w-0">
        <span className="font-semibold text-foreground">{props.fact}</span>
        {props.hint === undefined ? null : ` ${props.hint}`}
      </span>
    </p>
  );
}
