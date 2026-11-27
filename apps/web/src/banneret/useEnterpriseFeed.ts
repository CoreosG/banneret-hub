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

export function hasRelayPermission(
  me: BanneretEnrolmentView["me"] | undefined,
  permission: string,
) {
  return me?.permissions.includes(permission) ?? false;
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

  const outside = enrolment?.me?.admission === "outside";
  const can = (permission: string) => hasRelayPermission(enrolment?.me, permission);
  const allowedSections = feed.sections.filter(
    (s) => !["team", "health", "pool"].includes(s) || can("hub." + s),
  );
  return target === null || workspace === null || enrolment === null
    ? null
    : {
        environmentId: target.environmentId,
        target,
        workspace,
        enrolment,
        feed: {
          ...feed,
          chatFlags: outside
            ? (feed.chatFlags?.filter((flag) => flag !== "group_dms") ?? [])
            : feed.chatFlags,
          sectionsKnown: outside || feed.sectionsKnown || !can("hub.team"),
          sections: allowedSections,
          team: can("hub.team") ? feed.team : null,
          needs: feed.needs?.filter((it) => it.kind !== "health" || can("hub.health")) ?? null,
        },
      };
}
