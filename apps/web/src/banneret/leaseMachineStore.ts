// Banneret Hub: the machine a person last chose for take and release, per repository and overall. It is
// per-viewer UI state in this browser's storage, read as a default only: a remembered machine that is no
// longer connected, joined or the person's own is skipped (leaseRoute.logic). A private window keeps
// working, just without remembering.
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { useProjects, useServerConfigs } from "../state/entities";
import { type RelayTarget, useEnrolmentStore } from "./enrolmentStore";
import { useLeaseEntry } from "./leaseStore";
import {
  leaseRoute,
  repoChoiceKey,
  type LeaseEnvironment,
  type LeaseRoute,
} from "./leaseRoute.logic";
import type { TaskIdentity } from "./taskSurface";
import type { IssueRef } from "@t3tools/contracts";

const STORAGE_KEY = "banneret:lease-machines";

interface LeaseMachineChoices {
  readonly byRepo: Readonly<Record<string, EnvironmentId>>;
  readonly last: EnvironmentId | null;
}

const EMPTY: LeaseMachineChoices = { byRepo: {}, last: null };

function readChoices(): LeaseMachineChoices {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const { byRepo, last } = parsed as { byRepo?: unknown; last?: unknown };
    const repos =
      typeof byRepo === "object" && byRepo !== null
        ? Object.fromEntries(
            Object.entries(byRepo).filter(([, value]) => typeof value === "string"),
          )
        : {};
    return {
      byRepo: repos as Record<string, EnvironmentId>,
      last: typeof last === "string" ? (last as EnvironmentId) : null,
    };
  } catch {
    return EMPTY;
  }
}

export const useLeaseMachineStore = create<LeaseMachineChoices>(() => readChoices());

/** Remembers the machine chosen for a repository; it becomes the default there and for new ones. */
export function chooseLeaseMachine(
  ref: { readonly tracker: string; readonly scope: string },
  environmentId: EnvironmentId,
): void {
  const next = {
    byRepo: { ...useLeaseMachineStore.getState().byRepo, [repoChoiceKey(ref)]: environmentId },
    last: environmentId,
  };
  useLeaseMachineStore.setState(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Remembered for this window only.
  }
}

/** Every environment this client knows, with what the route needs from each. */
function useLeaseEnvironments(): ReadonlyArray<LeaseEnvironment> {
  const configs = useServerConfigs();
  const projects = useProjects();
  const views = useEnrolmentStore((state) => state.views);
  return [...configs].map(([environmentId, config]) => ({
    environmentId,
    label: config?.environment?.label,
    issues: config?.environment?.capabilities?.issues === true,
    projects: projects.filter((project) => project.environmentId === environmentId),
    enrolments: views[environmentId] ?? [],
  }));
}

/** Where the task's take and release run from this window; see leaseRoute.logic for the rules. */
export function useLeaseRoute(
  target: RelayTarget,
  task: TaskIdentity,
  pageRef: IssueRef | null,
): LeaseRoute {
  const environments = useLeaseEnvironments();
  const heldOn = useLeaseEntry(target, task.id)?.heldOn ?? null;
  const choices = useLeaseMachineStore();
  const repo = repoChoiceKey(task.ref);
  const preferred = [choices.byRepo[repo], choices.last].filter(
    (environmentId): environmentId is EnvironmentId =>
      environmentId !== undefined && environmentId !== null,
  );
  return leaseRoute({
    page: target,
    taskUrl: task.ref.url,
    repo: task.ref.scope,
    environments,
    pageRef,
    heldOn,
    preferred,
  });
}
