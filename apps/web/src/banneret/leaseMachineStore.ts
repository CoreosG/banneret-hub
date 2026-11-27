// The machine explicitly selected for this task in this window.
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { useServerConfigs } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { type RelayTarget, useEnrolmentStore } from "./enrolmentStore";
import { useLeaseEntry } from "./leaseStore";
import {
  leaseRoute,
  repoChoiceKey,
  type LeaseEnvironment,
  type LeaseMachine,
  type LeaseRoute,
} from "./leaseRoute.logic";
import type { TaskIdentity } from "./taskSurface";

export const useLeaseMachineStore = create<{ choices: Record<string, EnvironmentId> }>(() => ({
  choices: {},
}));

const taskKey = (ref: { tracker: string; scope: string; key: string }) =>
  repoChoiceKey(ref) + "#" + ref.key;

export function chooseLeaseMachine(ref: LeaseMachine["ref"], environmentId: EnvironmentId) {
  useLeaseMachineStore.setState((state) => ({
    choices: { ...state.choices, [taskKey(ref)]: environmentId },
  }));
}

/**
 * Every connected environment whose enrolments have been read, with what the route needs from each. A
 * disconnected one keeps a cached config and its last enrolment, but a call to it cannot run.
 */
function useLeaseEnvironments(): ReadonlyArray<LeaseEnvironment> {
  const configs = useServerConfigs();
  const connected = useConnectedEnvironmentIds();
  const views = useEnrolmentStore((state) => state.views);
  return [...configs].flatMap(([environmentId, config]) => {
    const enrolments = views[environmentId];
    if (!connected.includes(environmentId) || enrolments === undefined) return [];
    return [
      {
        environmentId,
        label: config?.environment?.label,
        issues: config?.environment?.capabilities?.issues === true,
        enrolments,
      },
    ];
  });
}

/** Where the task's take and release run from this window; see leaseRoute.logic for the rules. */
export function useLeaseRoute(target: RelayTarget, task: TaskIdentity): LeaseRoute {
  const environments = useLeaseEnvironments();
  const heldOn = useLeaseEntry(target, task.id)?.heldOn ?? null;
  const choice = useLeaseMachineStore((state) => state.choices[taskKey(task.ref)]);
  return leaseRoute({
    page: target,
    taskRef: task.ref,
    environments,
    heldOn,
    preferred: choice ? [choice] : [],
  });
}
