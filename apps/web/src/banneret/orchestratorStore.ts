import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type LocalApi,
  type ContextMenuItem,
  type ContextMenuSource,
  TASK_LEASE_WS_METHODS,
  type OrchestratorSelection,
  type ProjectId,
  type ScopedThreadRef,
  type OrchestratorDesignations,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { create } from "zustand";
import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";
import type { Project } from "../types";
import { relayKey, type RelayTarget } from "./enrolmentStore";
import { resolveWorkspaces, workspaceIdForProject } from "./workspaces.logic";
import { useWorkspacesStore } from "./workspacesStore";

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
  const items = [
    {
      id: "banneret-main" as const,
      label: main
        ? `Clear my main orchestrator for ${company.name}`
        : `Use as my main orchestrator for ${company.name}`,
    },
    ...(project.isScratch
      ? []
      : [
          {
            id: "banneret-project" as const,
            label: local
              ? "Clear this project's orchestrator"
              : "Use as this project's orchestrator",
          },
        ]),
  ];
  return {
    items,
    run: (id: "banneret-main" | "banneret-project") =>
      selectOrchestrator(target, {
        action: "set",
        relayOrigin: target.relayOrigin,
        ...(id === "banneret-project" ? { projectId: project.id } : {}),
        threadId: (id === "banneret-main" ? main : local) ? null : ref.threadId,
      }),
  };
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
    if (choice === "banneret-main" || choice === "banneret-project") {
      await extra.run(choice);
      return null;
    }
    return choice;
  };
