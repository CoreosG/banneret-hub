// Banneret Hub: with Workspaces tabs, whichever chat the router shows brings its workspace to the
// front and becomes its last chat, however it was opened. It reacts to a change of chat or of that
// chat's workspace only, so closing a tab or picking another is never undone by the old route.
import { useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useRouteProject } from "../useRouteProject";
import { useProjectWorkspaces, workspaceHasProject } from "./useProjectWorkspaces";
import { visit } from "./workspaceTabsStore";

export function WorkspaceTabsFollower() {
  const workspaces = useProjectWorkspaces();
  const project = useRouteProject()?.project ?? null;
  const target = resolveThreadRouteTarget(useParams({ strict: false }));
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  const workspace =
    project === null
      ? undefined
      : workspaces.find((w) => workspaceHasProject(w, project.environmentId, project.id));
  const href =
    target === null
      ? null
      : target.kind === "draft"
        ? `/draft/${target.draftId}`
        : `/${target.threadRef.environmentId}/${target.threadRef.threadId}`;
  const observe = useEffectEvent((chatHref: string) => {
    if (workspace === undefined) return;
    const ref = target?.kind === "server" ? target.threadRef : draft;
    visit(workspace, {
      href: chatHref,
      threadRef: ref === null ? null : { environmentId: ref.environmentId, threadId: ref.threadId },
    });
  });
  const workspaceKey = workspace?.key;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the chat the router shows, once it and its project are known
  useEffect(() => {
    if (href !== null && workspaceKey !== undefined) observe(href);
  }, [href, workspaceKey]);
  return null;
}
