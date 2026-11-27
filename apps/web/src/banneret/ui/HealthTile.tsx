// Fork UI kit: one health measure. Label, state, summary and when it was last observed.
import { cn } from "../../lib/utils";
import { healthLabel } from "./labels";
import { RelativeTime } from "./RelativeTime";
import { TYPE, toneProps } from "./tokens";

/** `state` is open: `good`, `warning`, `bad` and `not_measured` are known. */
export function HealthTile(props: {
  readonly label: string;
  readonly state: string;
  readonly summary?: string | undefined;
  readonly observedAt?: string | null | undefined;
  readonly nowMs?: number;
  readonly className?: string;
}) {
  const { label, tone } = healthLabel(props.state);
  return (
    <div
      data-slot="health-tile"
      data-health={props.state}
      className={cn("flex min-w-0 flex-col gap-1 rounded-lg border bg-card p-3", props.className)}
    >
      <span className={cn(TYPE.meta, "truncate")}>{props.label}</span>
      <span className="inline-flex items-center gap-1.5 font-medium text-sm">
        <span aria-hidden className="size-2 shrink-0 rounded-full" {...toneProps(tone, "solid")} />
        <span {...toneProps(tone, "fg")}>{label}</span>
      </span>
      {props.summary === undefined || props.summary === "" ? null : (
        <span className={cn(TYPE.meta, "line-clamp-2")}>{props.summary}</span>
      )}
      {props.observedAt == null ? null : (
        <RelativeTime
          at={props.observedAt}
          prefix="Seen"
          className={TYPE.meta}
          {...(props.nowMs === undefined ? {} : { nowMs: props.nowMs })}
        />
      )}
    </div>
  );
}
