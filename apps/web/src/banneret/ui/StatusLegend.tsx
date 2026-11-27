// Fork UI kit: the status legend. Each chip shows a status's icon, label and count; the ring
// explains "agent at work".
import { cn } from "../../lib/utils";
import { legendStatuses, statusView } from "./status";
import { StatusIcon } from "./StatusPill";
import { toneProps } from "./tokens";

export function StatusLegend(props: {
  readonly counts?: Readonly<Record<string, number>>;
  readonly statuses?: ReadonlyArray<string>;
  readonly showAtWork?: boolean;
  readonly className?: string;
}) {
  const { counts } = props;
  return (
    <ul
      aria-label="Status legend"
      className={cn("flex flex-wrap items-center gap-2", props.className)}
    >
      {legendStatuses(counts, props.statuses).map((status) => {
        const view = statusView(status);
        const count = counts?.[status];
        const empty = count === 0;
        const tone =
          view.tone === null || empty
            ? toneProps(view.tone ?? "muted", "fg")
            : toneProps(view.tone, "soft", "fg");
        return (
          <li
            key={status}
            data-status={status}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md px-2 font-medium text-2xs",
              view.tone === null && "border border-border",
              empty && "opacity-45",
            )}
            {...tone}
          >
            <StatusIcon status={status} />
            <span>{view.label}</span>
            {count === undefined ? null : (
              <span data-count className="font-semibold tabular-nums">
                {count}
              </span>
            )}
          </li>
        );
      })}
      {props.showAtWork === false ? null : (
        <li className="inline-flex h-6 items-center gap-1.5 px-2 text-2xs text-muted-foreground">
          <span aria-hidden className="inline-flex size-3 rounded-full ring-2 ring-primary" />
          Agent at work
        </li>
      )}
    </ul>
  );
}
