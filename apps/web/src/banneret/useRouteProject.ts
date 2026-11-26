// Banneret Hub: the project of whatever the chat route shows, a server thread or a draft, however it
// was opened (palette, sidebar, link, notification). The workspace auto-switch follows it.
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useParams } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { useProject, useThreadShell } from "../state/entities";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { Project } from "../types";

export interface RouteProject {
  /**
   * The routed thread and its project. A draft keeps its thread id when it is sent, so sending a
   * draft does not count as opening something new; moving a draft to another project does.
   */
  readonly key: string;
  /** Null until the project has loaded. */
  readonly project: Project | null;
}

export function useRouteProject(): RouteProject | null {
  const target = resolveThreadRouteTarget(useParams({ strict: false }));
  const shell = useThreadShell(target?.kind === "server" ? target.threadRef : null);
  // A thread that was just sent may not have its shell yet; its draft still names the project.
  const draft = useComposerDraftStore((store) =>
    target === null
      ? null
      : target.kind === "draft"
        ? store.getDraftSession(target.draftId)
        : store.getDraftSessionByRef(target.threadRef),
  );
  const owner =
    shell !== null
      ? { environmentId: shell.environmentId, threadId: shell.id, projectId: shell.projectId }
      : draft;
  const project = useProject(
    owner === null ? null : scopeProjectRef(owner.environmentId, owner.projectId),
  );
  if (owner === null) return null;
  const threadKey = scopedThreadKey(scopeThreadRef(owner.environmentId, owner.threadId));
  return { key: `${threadKey}|${owner.projectId}`, project };
}
