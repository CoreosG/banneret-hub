// Banneret Hub: the issue reference a task is read and written through. A task has one only when this
// environment can read issues and one of its projects is on the task's tracker and scope; take,
// release and the embedded thread all need it.
import {
  mayContainStandaloneIssueLink,
  resolveIssueLinkTarget,
} from "@t3tools/client-runtime/issue-links";
import type { EnvironmentId, IssueRef } from "@t3tools/contracts";

import { useProjects, useServerConfigs } from "../state/entities";
import { issueTrackerEnvironment } from "../state/issueTrackers";
import { useEnvironmentQuery } from "../state/query";
import type { TaskIdentity } from "./taskSurface";

/** Null when no project here is on the task's tracker. */
export function useTaskIssueRef(environmentId: EnvironmentId, task: TaskIdentity): IssueRef | null {
  const issuesSupported =
    useServerConfigs().get(environmentId)?.environment.capabilities.issues === true;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  // Only a standalone tracker's link asks for its bindings, whose read probes the tracker.
  const trackers =
    useEnvironmentQuery(
      issuesSupported && mayContainStandaloneIssueLink(task.ref.url)
        ? issueTrackerEnvironment.connections({ environmentId, input: {} })
        : null,
    ).data ?? undefined;
  const target = issuesSupported
    ? resolveIssueLinkTarget({ url: task.ref.url, projects, trackers })
    : null;
  const matches =
    target !== null &&
    target.ref.tracker === task.ref.tracker &&
    target.ref.key.toLowerCase() === task.ref.key.toLowerCase();
  return matches ? target.ref : null;
}
