// Fork UI kit: a relative English date ("3 h ago") with the exact time in its tooltip.
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { agoLabel, exactTimeLabel } from "./relativeTime";

/** The current minute in ms. Reads the minute tick because the compiler caches a render-time Date.now(). */
export function useNowMs(): number {
  return Date.parse(`${useNowMinute()}:00.000Z`);
}

/** `nowMs` pins the clock (tests, lists that share one tick); otherwise it follows the minute tick. */
export function RelativeTime(props: {
  readonly at: string;
  readonly prefix?: string;
  readonly nowMs?: number;
  readonly className?: string;
}) {
  const tick = useNowMs();
  const label = agoLabel(props.at, props.nowMs ?? tick);
  const text = props.prefix === undefined ? label : `${props.prefix} ${label}`;
  const exact = exactTimeLabel(props.at);
  const className = cn("tabular-nums", props.className);
  if (exact === "") return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={props.at} className={className} />}>
        {text}
      </TooltipTrigger>
      <TooltipPopup>{exact}</TooltipPopup>
    </Tooltip>
  );
}
