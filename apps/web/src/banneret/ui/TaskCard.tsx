// Fork UI kit: a board card. Ref line, title, status pill, lease chip, pull request line.
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { statusView } from "./status";
import { StatusPill } from "./StatusPill";
import { TYPE, toneProps } from "./tokens";

/**
 * `lease` and `footer` are slots (a `LeaseChip`, a pull request line). With `onOpen` the card is
 * one button; without it, a plain box. Only attention statuses get the left accent bar.
 */
export function TaskCard(props: {
  readonly title: string;
  readonly status: string;
  readonly refLabel?: string | undefined;
  /** The ref's number; it never truncates, only `refLabel` before it does. */
  readonly refNumber?: string | undefined;
  readonly why?: string | undefined;
  readonly atWork?: boolean;
  readonly blockedBy?: string | undefined;
  readonly lease?: ReactNode;
  readonly footer?: ReactNode;
  readonly onOpen?: (() => void) | undefined;
  readonly className?: string;
}) {
  const view = statusView(props.status, { blockedBy: props.blockedBy });
  const className = cn(
    "relative flex w-full min-w-0 flex-col gap-2 overflow-hidden rounded-lg border bg-card p-3 text-left",
    props.onOpen !== undefined &&
      "cursor-pointer outline-none hover:border-input hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    props.className,
  );
  const content = (
    <>
      {view.accent && view.tone !== null ? (
        <span
          aria-hidden
          data-slot="accent-bar"
          className="absolute inset-y-0 left-0 w-0.75"
          {...toneProps(view.tone, "solid")}
        />
      ) : null}
      {props.refLabel === undefined ? null : (
        <span className={cn(TYPE.ref, "flex min-w-0 whitespace-nowrap")} data-slot="task-ref">
          <span className="min-w-0 truncate">{props.refLabel}</span>
          {props.refNumber === undefined ? null : (
            <span className="shrink-0">{props.refNumber}</span>
          )}
        </span>
      )}
      <span className={cn(TYPE.cardTitle, "line-clamp-2", view.struck && "line-through")}>
        {props.title}
      </span>
      <StatusPill
        status={props.status}
        why={props.why}
        atWork={props.atWork === true}
        blockedBy={props.blockedBy}
      />
      {props.lease}
      {props.footer === undefined ? null : <span className={TYPE.meta}>{props.footer}</span>}
    </>
  );
  if (props.onOpen === undefined) {
    return (
      <div className={className} data-slot="task-card" data-status={props.status}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      data-slot="task-card"
      data-status={props.status}
      onClick={props.onOpen}
    >
      {content}
    </button>
  );
}
