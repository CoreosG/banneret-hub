// Fork UI kit: small toned chips. A lease chip names who holds an item and how that claim is
// going; a reason chip says why an item is stuck.
import { UserRoundIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { leaseLabel, reasonLabel } from "./labels";
import { useNowMs } from "./RelativeTime";
import { toneProps } from "./tokens";

const CHIP =
  "inline-flex min-h-5 max-w-full items-center gap-1 self-start rounded-md border px-1.5 font-medium text-2xs";

/**
 * Holder and lease state. It wraps in a narrow column and never truncates. An empty `holder`
 * drops the name. `nowMs` pins the clock; otherwise it follows the minute tick.
 */
export function LeaseChip(props: {
  readonly holder?: string | undefined;
  readonly state: string;
  readonly staleAt: string;
  readonly nowMs?: number;
  readonly className?: string;
}) {
  const tick = useNowMs();
  const { label, tone } = leaseLabel(props, props.nowMs ?? tick);
  const holder = props.holder?.trim() ?? "";
  const looks = tone === "muted" ? (["edge"] as const) : (["tint", "edge"] as const);
  return (
    <span
      data-slot="lease-chip"
      data-lease={props.state}
      className={cn(CHIP, "flex-wrap py-0.5 leading-4", props.className)}
      {...toneProps(tone, ...looks)}
    >
      <UserRoundIcon
        aria-hidden
        className="size-3 shrink-0"
        {...toneProps(label === "live" ? "ok" : tone, "fg")}
      />
      {holder === "" ? null : <span className="break-all text-foreground">{holder}</span>}
      <span {...toneProps(tone, "fg")}>{label}</span>
    </span>
  );
}

/** Why an item is stuck, in a few words. An unknown reason keeps its own word. */
export function ReasonChip(props: { readonly reason: string; readonly className?: string }) {
  const { label, tone } = reasonLabel(props.reason);
  return (
    <span
      data-slot="reason-chip"
      data-reason={props.reason}
      className={cn(CHIP, "h-5 whitespace-nowrap", props.className)}
      {...toneProps(tone, "tint", "edge", "fg")}
    >
      {label}
    </span>
  );
}
