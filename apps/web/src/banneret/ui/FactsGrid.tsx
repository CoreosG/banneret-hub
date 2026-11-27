// Fork UI kit: label and value pairs in two columns, as in the task dialog.
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export interface Fact {
  readonly label: string;
  readonly value: ReactNode;
}

/** Facts with no value (`undefined` or `null`) are left out rather than shown blank. */
export function FactsGrid(props: {
  readonly facts: ReadonlyArray<Fact>;
  readonly className?: string;
}) {
  const facts = props.facts.filter((fact) => fact.value !== undefined && fact.value !== null);
  if (facts.length === 0) return null;
  return (
    <dl className={cn("grid grid-cols-1 gap-x-4 sm:grid-cols-2", props.className)}>
      {facts.map((fact) => (
        <div key={fact.label} className="grid min-h-9 grid-cols-[96px_1fr] items-center gap-2">
          <dt className="truncate text-muted-foreground text-xs">{fact.label}</dt>
          <dd className="min-w-0 text-sm">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
