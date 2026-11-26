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

export function StatusLegend(props: { readonly className?: string }) {
  return (
    <ul
      aria-label="Status legend"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", props.className)}
    >
      {STATUS_VOCABULARY.map((entry) => (
        <li key={entry.status}>
          <StatusMark status={entry.status} />
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
        <span aria-hidden className="inline-flex size-4 rounded-full ring-2 ring-primary" />
        agent at work
      </li>
    </ul>
  );
}
