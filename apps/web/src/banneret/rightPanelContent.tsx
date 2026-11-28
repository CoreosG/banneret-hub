// Banneret Hub: the body of the fork's right panel surfaces. Kept apart from rightPanelSurfaces so
// the tab strip does not load the panels.
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import PortsPanel from "../components/ports/PortsPanel";
import type { RightPanelSurface } from "../rightPanelStore";
import { TaskPanel } from "./TaskPanel";

export const rightPanelContent = (
  surface: Extract<RightPanelSurface, { kind: "ports" | "task" }>,
  threadRef: ScopedThreadRef,
  environmentId: EnvironmentId,
  visible: boolean,
) =>
  surface.kind === "task" ? (
    <TaskPanel surface={surface} threadRef={threadRef} />
  ) : (
    <PortsPanel environmentId={environmentId} visible={visible} />
  );
