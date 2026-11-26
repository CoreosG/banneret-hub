// Banneret Hub: the Enterprise feed for the active workspace, when this environment has joined that
// workspace's company. Rows and pages share it, so the feed stays followed while either is shown.
import type { BanneretWorkspace, EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnrolmentView } from "./enrolmentStore";
import { type EnvironmentFeed, useEnvironmentFeed, watchFeed } from "./relayFeedStore";
import { effectiveWorkspaceId } from "./workspaces.logic";
import { useWorkspaces, useWorkspacesStore } from "./workspacesStore";

export interface EnterpriseFeed {
  readonly environmentId: EnvironmentId;
  readonly workspace: BanneretWorkspace;
  readonly feed: EnvironmentFeed;
}

export function useEnterpriseFeed(): EnterpriseFeed | null {
  const environmentId = usePrimaryEnvironmentId();
  const workspaces = useWorkspaces();
  const activeId = effectiveWorkspaceId(
    useWorkspacesStore((state) => state.activeId),
    workspaces,
  );
  const workspace = workspaces.find((candidate) => candidate.id === activeId) ?? null;
  const enrolment = useEnrolmentView(environmentId);
  const enabled =
    environmentId !== null &&
    workspace?.relay !== undefined &&
    enrolment?.state === "configured" &&
    enrolment.workspaceId === workspace.id;
  const watched = enabled ? environmentId : null;
  const feed = useEnvironmentFeed(watched);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's relay feed while a configured Enterprise workspace is shown
  useEffect(() => {
    if (watched === null) return;
    return watchFeed(watched);
  }, [watched]);

  return watched === null || workspace === null
    ? null
    : { environmentId: watched, workspace, feed };
}
