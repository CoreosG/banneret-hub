// Banneret Hub: the Ports icon for tabs and menus, with a small count of active forwards.
import { CableIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { usePortForwards } from "~/state/portForwards";

import type { SVGProps } from "react";

export function PortsIcon({ className }: Pick<SVGProps<SVGSVGElement>, "className">) {
  const count = usePortForwards().length;
  return (
    <span className="relative inline-flex shrink-0">
      <CableIcon className={cn("shrink-0", className)} />
      {count > 0 ? (
        <span
          data-testid="ports-forward-count"
          className="absolute -top-1 -right-1.5 min-w-3 rounded-full bg-primary px-0.5 text-center text-4xs leading-3 font-medium text-primary-foreground"
        >
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </span>
  );
}

/** The add-tab menu and empty-state entry for Ports; empty where the host offers no Ports. */
export function portsSurfaceActions(onAddPorts: (() => void) | undefined) {
  return onAddPorts
    ? [
        {
          label: "Ports",
          icon: PortsIcon,
          shortcut: "O",
          available: true,
          disabledReason: "",
          onClick: onAddPorts,
        },
      ]
    : [];
}
