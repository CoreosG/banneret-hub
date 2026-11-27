// Banneret Hub: the status mark the Task tab and the Feed share. Each mark shows its word; the ring says an
// agent is at work on the task. Relay strings stay plain text.
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { statusWord } from "./board.logic";

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
