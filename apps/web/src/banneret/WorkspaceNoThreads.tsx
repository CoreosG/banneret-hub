// Banneret Hub: the sidebar's empty line names the active workspace, so an empty workspace does not
// read like an empty app. Upstream lists a project only once it has threads.
import type { ReactNode } from "react";

import { effectiveWorkspaceId } from "./workspaces.logic";
import { useWorkspaces, useWorkspacesStore } from "./workspacesStore";

export function WorkspaceNoThreads(props: {
  /** Upstream's line, kept for Personal. */
  readonly fallback: ReactNode;
}) {
  const workspaces = useWorkspaces();
  const activeId = effectiveWorkspaceId(
    useWorkspacesStore((state) => state.activeId),
    workspaces,
  );
  const active = workspaces.find((workspace) => workspace.id === activeId);
  return active === undefined ? props.fallback : <>No threads in {active.name} yet</>;
}
