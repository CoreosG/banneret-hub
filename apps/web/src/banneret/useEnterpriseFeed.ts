// Banneret Hub: the Enterprise feed for the active workspace, when this environment has joined that
// workspace's company. Each Enterprise workspace has its own relay, so switching workspaces switches
// the feed. Rows and pages share it, so the feed stays followed while either is shown.
import type { BanneretEnrolmentView, BanneretWorkspace, EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { type RelayTarget, useEnrolmentView } from "./enrolmentStore";
import { type EnvironmentFeed, useEnvironmentFeed, watchFeed } from "./relayFeedStore";
import { effectiveWorkspaceId } from "./workspaces.logic";
import { useWorkspaces, useWorkspacesStore } from "./workspacesStore";

export interface EnterpriseFeed {
  readonly environmentId: EnvironmentId;
  /** The active workspace's relay on this environment: what every read and lease call names. */
  readonly target: RelayTarget;
  readonly workspace: BanneretWorkspace;
  /** This environment's enrolment with that relay (configured). */
  readonly enrolment: BanneretEnrolmentView;
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
  const relayOrigin = workspace?.relay?.origin ?? null;
  const enrolment = useEnrolmentView(environmentId, relayOrigin);
  const enabled =
    environmentId !== null &&
    relayOrigin !== null &&
    enrolment?.state === "configured" &&
    enrolment.workspaceId === workspace?.id;
  const watchedOrigin = enabled ? relayOrigin : null;
  const target =
    environmentId === null || watchedOrigin === null
      ? null
      : { environmentId, relayOrigin: watchedOrigin };
  const feed = useEnvironmentFeed(target);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the server's relay feed while a configured Enterprise workspace is shown
  useEffect(() => {
    if (environmentId === null || watchedOrigin === null) return;
    return watchFeed({ environmentId, relayOrigin: watchedOrigin });
  }, [environmentId, watchedOrigin]);

  return target === null || workspace === null || enrolment === null
    ? null
    : {
        environmentId: target.environmentId,
        target,
        workspace,
        enrolment,
        feed:
          enrolment.me?.admission === "outside"
            ? {
                ...feed,
                sectionsKnown: true,
                chatFlags: feed.chatFlags?.filter((flag) => flag !== "group_dms") ?? [],
                sections: feed.sections.filter(
                  (s) =>
                    !["team", "pool", "health"].includes(s) ||
                    enrolment.me?.permissions.includes("hub." + s),
                ),
                team: enrolment.me.permissions.includes("hub.team") ? feed.team : null,
                needs:
                  feed.needs?.filter(
                    (item) =>
                      item.kind !== "health" || enrolment.me?.permissions.includes("hub.health"),
                  ) ?? null,
              }
            : feed,
      };
}
