import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type LocalApi,
  type ContextMenuItem,
  type ContextMenuSource,
  TASK_LEASE_WS_METHODS,
  type OrchestratorSelection,
  type ProjectId,
  type ThreadId,
  type ScopedThreadRef,
  type OrchestratorDesignations,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { create } from "zustand";
import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShells } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";
import type { Project } from "../types";
import { relayKey, type RelayTarget } from "./enrolmentStore";
import { resolveWorkspaces, workspaceIdForProject } from "./workspaces.logic";
import { useWorkspacesStore } from "./workspacesStore";

const sandboxHandoffCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:sandbox-handoff",
  tag: TASK_LEASE_WS_METHODS.sandboxHandoff,
});
export async function sandboxHandoff(target: RelayTarget, taskId: string, requestId: string) {
  const result = await runAtomCommand(appAtomRegistry, sandboxHandoffCommand, {
    environmentId: target.environmentId,
    input: { relayOrigin: target.relayOrigin, taskId, requestId },
  });
  if (result._tag === "Success") return result.value;
  toastManager.add({
    type: "error",
    title: "Could not send sandbox request",
    description: String(Cause.squash(result.cause)),
  });
  return null;
}

const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:orchestrator",
  tag: TASK_LEASE_WS_METHODS.orchestrator,
});
export const useOrchestrators = create<{ byRelay: Record<string, OrchestratorDesignations> }>(
  () => ({
    byRelay: {},
  }),
);
const revisions = new Map<string, number>();
export async function selectOrchestrator(target: RelayTarget, input: OrchestratorSelection) {
  const key = relayKey(target);
  const revision = revisions.get(key);
  const result = await runAtomCommand(appAtomRegistry, command, {
    environmentId: target.environmentId,
    input,
  });
  if (result._tag === "Success") {
    if (input.action !== "get" || revisions.get(key) === revision) {
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      useOrchestrators.setState((s) => ({ byRelay: { ...s.byRelay, [key]: result.value } }));
    }
    return result.value;
  }
  if (input.action !== "get")
    toastManager.add({
      type: "error",
      title: "Could not select the orchestrator",
      description: String(Cause.squash(result.cause)),
    });
  return null;
}

async function orchestratorMenu(project: Project | null, ref: ScopedThreadRef) {
  if (!project) return null;
  const state = useWorkspacesStore.getState();
  const workspaces = resolveWorkspaces(state.local, ...Object.values(state.byEnvironment));
  const company = workspaces.find(
    (w) =>
      w.id === (project.isScratch ? state.activeId : workspaceIdForProject(project, workspaces)),
  );
  if (company?.kind !== "enterprise" || !company.relay) return null;
  const target = { environmentId: ref.environmentId, relayOrigin: company.relay.origin };
  const current = await selectOrchestrator(target, {
    action: "get",
    relayOrigin: target.relayOrigin,
  });
  if (!current) return null;
  const main = current.main === ref.threadId;
  const local = current.projects[project.id] === ref.threadId;
  type MenuId = `banneret-${string}`;
  const actions = new Map<MenuId, { projectId?: ProjectId; threadId: ThreadId | null }>();
  const items: ContextMenuItem<MenuId>[] = [];
  const addScope = (scope: "main" | "project", selected: boolean, label: string) => {
    const id = `banneret-${scope}` as const;
    const scoped = scope === "project" ? { projectId: project.id } : {};
    actions.set(id, { ...scoped, threadId: selected ? null : ref.threadId });
    items.push({ id, label });
    if (!selected) return;
    const children: ContextMenuItem<MenuId>[] = [];
    for (const shell of readThreadShells()) {
      if (
        shell.environmentId !== ref.environmentId ||
        shell.id === ref.threadId ||
        shell.archivedAt ||
        shell.settledAt ||
        shell.settledOverride === "settled"
      )
        continue;
      const candidate = readProject({
        environmentId: shell.environmentId,
        projectId: shell.projectId,
      });
      if (
        !candidate ||
        (scope === "project"
          ? candidate.id !== project.id
          : !candidate.isScratch && workspaceIdForProject(candidate, workspaces) !== company.id)
      )
        continue;
      const childId = `${id}-${shell.id}` as const;
      actions.set(childId, { ...scoped, threadId: shell.id });
      children.push({ id: childId, label: shell.title });
    }
    items.push({
      id: `${id}-picker`,
      label: main && local ? `Choose another ${scope} orchestrator…` : "Choose another…",
      disabled: !children.length,
      children,
    });
  };
  addScope(
    "main",
    main,
    main ? "Retire as main orchestrator" : `Use as my main orchestrator for ${company.name}`,
  );
  if (!project.isScratch)
    addScope(
      "project",
      local,
      local
        ? "Demote (stop being this project's orchestrator)"
        : "Use as this project's orchestrator",
    );
  return {
    items,
    run: async (id: MenuId) => {
      const action = actions.get(id);
      if (action)
        await selectOrchestrator(target, {
          action: "set",
          relayOrigin: target.relayOrigin,
          ...action,
        });
    },
  };
}
function isOrchestratorAction(choice: string | null): choice is `banneret-${string}` {
  return choice?.startsWith("banneret-") === true;
}
export const threadMenuFor =
  (api: LocalApi, ref: ScopedThreadRef, projectId: ProjectId) =>
  async (
    items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => {
    const extra = readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope)
      ? await orchestratorMenu(readProject({ environmentId: ref.environmentId, projectId }), ref)
      : null;
    if (!extra) return api.contextMenu.show(items, position, source);
    const choice = await api.contextMenu.show([...items, ...extra.items], position, source);
    if (isOrchestratorAction(choice)) {
      await extra.run(choice);
      return null;
    }
    return choice;
  };
