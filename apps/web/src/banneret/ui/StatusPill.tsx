// Fork UI kit: the one status pill. Icon shape, human label and tint, so colour is never the only
// signal. Its own look rather than Badge: Badge's sizes and radius differ and accept no restyle.
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  ContrastIcon,
  DotIcon,
  OctagonMinusIcon,
  Undo2Icon,
} from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { statusView, type StatusIconKind } from "./status";
import { toneProps } from "./tokens";

function DiamondAlertIcon(props: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden
    >
      <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

const ICONS = {
  check: CircleCheckIcon,
  half: ContrastIcon,
  diamond: DiamondAlertIcon,
  return: Undo2Icon,
  dashed: CircleDashedIcon,
  slash: CircleSlashIcon,
  octagon: OctagonMinusIcon,
  dot: DotIcon,
} satisfies Record<StatusIconKind, unknown>;

/** The status shape alone, for legends, map items and dense rows. */
export function StatusIcon(props: { readonly status: string; readonly className?: string }) {
  const view = statusView(props.status);
  const Icon = ICONS[view.icon];
  return (
    <Icon
      aria-hidden
      className={cn("size-3 shrink-0", props.className)}
      {...toneProps(view.tone ?? "muted", "fg")}
    />
  );
}

/**
 * A status pill. `why` (the relay's reason) is its tooltip, never printed. `atWork` rings it while
 * an agent works on the item. `blockedBy` names what a blocked item waits on.
 */
export function StatusPill(props: {
  readonly status: string;
  readonly why?: string | undefined;
  readonly atWork?: boolean;
  readonly blockedBy?: string | undefined;
  readonly className?: string;
}) {
  const view = statusView(props.status, { blockedBy: props.blockedBy });
  const Icon = ICONS[view.icon];
  const className = cn(
    "inline-flex h-5 max-w-full shrink-0 items-center gap-1 self-start whitespace-nowrap rounded-full pr-2 pl-1.5 font-medium text-2xs",
    view.tone === null && "border border-border",
    props.atWork === true && "ring-2 ring-primary ring-offset-2 ring-offset-card",
    props.className,
  );
  const tone = view.tone === null ? toneProps("muted", "fg") : toneProps(view.tone, "tint", "fg");
  const content = (
    <>
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{view.label}</span>
      {props.atWork === true ? <span className="sr-only">, agent at work</span> : null}
    </>
  );
  if (props.why === undefined || props.why === "") {
    return (
      <span className={className} data-status={props.status} data-slot="status-pill" {...tone}>
        {content}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={className}
            data-status={props.status}
            data-slot="status-pill"
            {...tone}
          />
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup>{props.why}</TooltipPopup>
    </Tooltip>
  );
}
