// Banneret Hub: the status marks Board, Map and Feed share. Each mark shows its word; the ring says an
// agent is at work on the task. Relay strings stay plain text.
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { STATUS_VOCABULARY, statusWord } from "./board.logic";

/** A status mark with its word, ringed while an agent is at work. `why` shows on hover. */
export function StatusMark(props: {
  readonly status: string;
  readonly why?: string | undefined;
  readonly atWork?: boolean;
}) {
  const { mark, word } = statusWord(props.status);
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground",
          props.atWork === true && "ring-2 ring-primary",
        )}
      >
        {mark}
      </span>
      <span className="truncate">{word}</span>
      {props.atWork === true ? <span className="sr-only">, agent at work</span> : null}
    </>
  );
  const className = "inline-flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs";
  if (props.why === undefined) {
    return (
      <span className={className} data-status={props.status}>
        {content}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn(className, "self-start")} data-status={props.status} />}
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup>{props.why}</TooltipPopup>
    </Tooltip>
  );
}

const Count = (props: { readonly count: number }) => (
  <span data-count className="text-foreground text-xs tabular-nums">
    {props.count}
  </span>
);

/**
 * `checked` is the board section's flag: without it the relay never applies the sign-off rule, so ●
 * is left out. With `counts` (the relay's `{<status>: n}`), each mark shows its count.
 */
export function StatusLegend(props: {
  readonly checked: boolean;
  readonly counts?: Readonly<Record<string, number>>;
  readonly className?: string;
}) {
  const { counts } = props;
  return (
    <ul
      aria-label="Status legend"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", props.className)}
    >
      {STATUS_VOCABULARY.filter((entry) => props.checked || entry.status !== "checked").map(
        (entry) => (
          <li key={entry.status} className="inline-flex items-center gap-1.5">
            <StatusMark status={entry.status} />
            {counts === undefined ? null : <Count count={counts[entry.status] ?? 0} />}
          </li>
        ),
      )}
      <li className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
        <span aria-hidden className="inline-flex size-4 rounded-full ring-2 ring-primary" />
        agent at work
      </li>
    </ul>
  );
}

/** Counts by status, each with its mark and word; statuses with none are left out. */
export function StatusCounts(props: {
  readonly counts: ReadonlyArray<{ readonly status: string; readonly count: number }>;
  readonly label: string;
  readonly className?: string;
}) {
  if (props.counts.length === 0) return null;
  return (
    <ul
      aria-label={props.label}
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", props.className)}
    >
      {props.counts.map((entry) => (
        <li key={entry.status} className="inline-flex items-center gap-1.5">
          <StatusMark status={entry.status} />
          <Count count={entry.count} />
        </li>
      ))}
    </ul>
  );
}
