// Fork UI kit: a compact build plan item. Status icon, title and number.
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { statusView } from "./status";
import { StatusIcon } from "./StatusPill";

/**
 * With `onOpen` the item opens its task. Without it the item has no task yet: dashed, muted and
 * not clickable. `why` is the tooltip.
 */
export function MapItemCard(props: {
  readonly title: string;
  readonly status: string;
  readonly number?: number | string | undefined;
  readonly why?: string | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly className?: string;
}) {
  const view = statusView(props.status);
  const onBoard = props.onOpen !== undefined;
  const className = cn(
    "inline-flex h-7.5 min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-2 text-left text-xs",
    onBoard
      ? "cursor-pointer bg-card outline-none hover:border-input hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      : "border-dashed text-muted-foreground",
    props.className,
  );
  const content = (
    <>
      <StatusIcon status={props.status} />
      <span className={cn("truncate", view.struck && "line-through")}>{props.title}</span>
      {props.number === undefined ? null : (
        <span className="shrink-0 text-muted-foreground tabular-nums">#{props.number}</span>
      )}
      <span className="sr-only">
        {onBoard ? `, ${view.label}` : `, ${view.label}, not on the board yet`}
      </span>
    </>
  );
  const tip = props.why ?? (onBoard ? undefined : "Not on the board yet");
  const shared = { className, "data-slot": "map-item", "data-status": props.status };
  if (tip === undefined || tip === "") {
    return onBoard ? (
      <button type="button" {...shared} onClick={props.onOpen}>
        {content}
      </button>
    ) : (
      <span {...shared}>{content}</span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          onBoard ? (
            <button type="button" {...shared} onClick={props.onOpen} />
          ) : (
            <span {...shared} />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup>{tip}</TooltipPopup>
    </Tooltip>
  );
}
