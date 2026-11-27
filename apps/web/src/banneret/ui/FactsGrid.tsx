// Fork UI kit: label and value pairs in two columns, as in the task dialog.
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { EMPTY_NOT_KNOWN } from "./labels";

export interface Fact {
  readonly label: string;
  readonly value: ReactNode;
  /** Spans both columns, for a value that runs long (a note). */
  readonly wide?: boolean;
  /** Said in a quiet tone when there is no value; "Not known" by default (see `labels.ts`). */
  readonly empty?: string;
}

/**
 * Every fact keeps its row, so the grid has the same shape for every task: a fact whose value is
 * missing (`undefined`) shows its `empty` words. `null` means the fact does not apply here (the
 * relay has no leases or no sign-off rule), and only then is the row left out.
 */
export function FactsGrid(props: {
  readonly facts: ReadonlyArray<Fact>;
  readonly className?: string;
}) {
  const facts = props.facts.filter((fact) => fact.value !== null);
  if (facts.length === 0) return null;
  return (
    <dl className={cn("grid grid-cols-1 gap-x-4 sm:grid-cols-2", props.className)}>
      {facts.map((fact) => (
        <div
          key={fact.label}
          className={cn(
            "grid min-h-9 grid-cols-[96px_1fr] items-center gap-2",
            fact.wide === true && "items-start py-2 sm:col-span-2",
          )}
        >
          <dt className="truncate text-muted-foreground text-xs">{fact.label}</dt>
          <dd className="min-w-0 text-sm">
            {fact.value === undefined ? (
              <span className="text-muted-foreground text-xs" data-fact-empty="">
                {fact.empty ?? EMPTY_NOT_KNOWN}
              </span>
            ) : (
              fact.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
