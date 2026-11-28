// Banneret Hub: the tab title and icon of the fork's right panel surfaces.
import { CircleDotIcon } from "lucide-react";

import { PortsIcon } from "../components/ports/PortsIcon";
import type { RightPanelSurface } from "../rightPanelStore";
import { taskTabTitle } from "./taskSurface";

export { portsSurfaceActions } from "../components/ports/PortsIcon";

type BanneretSurface = Extract<RightPanelSurface, { kind: "ports" | "task" }>;

export const title = (surface: BanneretSurface) =>
  surface.kind === "task" ? taskTabTitle(surface) : "Ports";

export const icon = (surface: BanneretSurface) =>
  surface.kind === "task" ? (
    <CircleDotIcon className="size-3 shrink-0" />
  ) : (
    <PortsIcon className="size-3" />
  );
