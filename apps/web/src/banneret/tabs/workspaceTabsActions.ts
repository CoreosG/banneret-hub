// Banneret Hub: what the workspace tabs, the sidebar's workspace list and the "Tabs show" setting
// do to the router and the stores.
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import type { AnyRouter } from "@tanstack/react-router";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { createNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readDelegatedUnderParent, readThreadShell, readThreadShells } from "../../state/entities";
import { resolveWorkspaces, workspaceIdForProject } from "../workspaces.logic";
import { setActiveWorkspace, useWorkspacesStore } from "../workspacesStore";
import { toScopedRef } from "./tabActions";
import { resumeChatTabs, shownRouteTarget } from "./tabsRoute";
import { useTabsStore } from "./tabsStore";
import { workspaceHasProject, type ProjectWorkspace } from "./useProjectWorkspaces";
import type { WorkspaceChat, WorkspaceEntry } from "./workspaceTabs.logic";
import { hide, seed, setSavedTabsMode, useWorkspaceTabsStore, visit } from "./workspaceTabsStore";

const draftIdOf = (href: string) =>
  href.startsWith("/draft/") ? DraftId.make(href.slice("/draft/".length)) : null;

/** The project a saved chat is in now, or null when this client cannot tell. */
function projectOfChat(chat: WorkspaceChat) {
  const drafts = useComposerDraftStore.getState();
  const draftId = draftIdOf(chat.href);
  if (draftId !== null) return drafts.getDraftSession(draftId);
  const ref = toScopedRef(chat);
  if (ref === null) return null;
  return readThreadShell(ref) ?? drafts.getDraftSessionByRef(ref);
}

/** Whether a workspace's last chat can still be opened as one of its chats. */
function canResume(workspace: ProjectWorkspace, chat: WorkspaceChat): boolean {
  const draftId = draftIdOf(chat.href);
  if (draftId !== null) {
    const drafts = useComposerDraftStore.getState();
    const session = drafts.getDraftSession(draftId);
    // A sent draft's address leads to its thread.
    if (session === null) return drafts.getPromotedDraftRedirect(draftId) !== null;
    return workspaceHasProject(workspace, session.environmentId, session.projectId);
  }
  const ref = toScopedRef(chat);
  if (ref === null) return false;
  const shell = readThreadShell(ref);
  // The shell leaves out older settled threads; the chat's route handles one that is missing.
  if (shell === null) return true;
  return (
    shell.deletedAt === null &&
    shell.archivedAt === null &&
    workspaceHasProject(workspace, shell.environmentId, shell.projectId)
  );
}

function newestChat(workspace: ProjectWorkspace): WorkspaceChat | null {
  const delegated = readDelegatedUnderParent();
  const own = readThreadShells().filter(
    (shell) =>
      shell.deletedAt === null &&
      shell.archivedAt === null &&
      workspaceHasProject(workspace, shell.environmentId, shell.projectId) &&
      !delegated.has(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))),
  );
  const newest = sortThreads(own, "updated_at")[0];
  return newest === undefined
    ? null
    : {
        href: `/${newest.environmentId}/${newest.id}`,
        threadRef: { environmentId: newest.environmentId, threadId: newest.id },
      };
}

/** Points the workspace switcher at a project's workspace, so the sidebar can list it. */
function showInSwitcher(workspace: ProjectWorkspace, chat: WorkspaceChat | null) {
  const owner = chat === null ? null : projectOfChat(chat);
  const project =
    workspace.projects.find(
      (p) => p.environmentId === owner?.environmentId && p.id === owner.projectId,
    ) ?? workspace.projects[0];
  // Every switcher choice lists the No project folders.
  if (project === undefined || project.isScratch) return;
  const { local, byEnvironment } = useWorkspacesStore.getState();
  const target = workspaceIdForProject(
    project,
    resolveWorkspaces(local, ...Object.values(byEnvironment)),
  );
  setActiveWorkspace(target);
}

/**
 * Brings a workspace to the front: its last chat, or its newest one, or a new draft in it. Its tab
 * opens if it was closed.
 */
export async function showWorkspace(router: AnyRouter, workspace: ProjectWorkspace) {
  visit(workspace, null);
  const saved = useWorkspaceTabsStore
    .getState()
    .entries.find((entry) => entry.key === workspace.key)?.lastChat;
  const chat = saved && canResume(workspace, saved) ? saved : newestChat(workspace);
  showInSwitcher(workspace, chat);
  if (chat !== null) {
    visit(workspace, chat);
    await router.navigate({ href: chat.href });
    return;
  }
  const project = workspace.projects[0];
  if (project === undefined) return;
  await createNewThreadHandler(router)(scopeProjectRef(project.environmentId, project.id));
}

/** The workspace tabs as drawn, and the selected one's entry key. */
export interface DrawnWorkspaceTabs {
  readonly tabs: ReadonlyArray<{
    readonly entry: WorkspaceEntry;
    readonly workspace: ProjectWorkspace;
  }>;
  readonly shownKey: string | null;
}

/**
 * Closes (hides) workspace tabs. When the selected one is among them, `instead` is shown in its
 * place if given, otherwise a neighbour. With none left the chat stays on screen: going home would
 * start a draft and bring a tab straight back.
 */
export async function closeWorkspaceTabs(
  router: AnyRouter,
  keys: ReadonlySet<string>,
  drawn: DrawnWorkspaceTabs,
  instead?: ProjectWorkspace,
) {
  const { closedShown, next } = hide(
    keys,
    drawn.tabs.map((tab) => tab.entry.key),
    drawn.shownKey,
    drawn.tabs.map((tab) => tab.workspace),
  );
  if (!closedShown) return;
  const target = instead ?? drawn.tabs.find((tab) => tab.entry.key === next)?.workspace;
  if (target !== undefined) await showWorkspace(router, target);
}

/** Tabs show: Workspaces. The open chats' projects get tabs, and the chat in view stays in front. */
export function showWorkspaceTabs(workspaces: ReadonlyArray<ProjectWorkspace>) {
  const { tabs, activeId } = useTabsStore.getState();
  const chatOf = (chat: WorkspaceChat) => {
    const owner = projectOfChat(chat);
    const workspace =
      owner === null
        ? undefined
        : workspaces.find((w) => workspaceHasProject(w, owner.environmentId, owner.projectId));
    return workspace === undefined ? null : { workspace, chat };
  };
  const open = tabs.flatMap((tab) => {
    if (tab.kind !== "thread") return [];
    const found = chatOf({ href: tab.href, threadRef: tab.threadRef });
    return found === null ? [] : [{ ...found, at: tab.lastActiveAt, id: tab.id }];
  });
  seed(open);
  setSavedTabsMode("workspaces");
  // In view: the chat under Settings; under a page, the active tab's or the latest used.
  const view = shownRouteTarget();
  const front =
    (view?.kind === "thread" ? chatOf({ href: view.href, threadRef: view.threadRef }) : null) ??
    open.find((chat) => chat.id === activeId) ??
    open.toSorted((a, b) => b.at - a.at)[0];
  if (front !== undefined) visit(front.workspace, front.chat);
}

/** Tabs show: Chats. The chats tabs are as they were left, plus the view in front. */
export function showChatTabs() {
  setSavedTabsMode("chats");
  resumeChatTabs();
}
