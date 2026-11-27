import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProjectService } from "../../project/ProjectService.ts";
import { projectKeyFromRemote } from "../relay/projectKey.ts";
import { readDesignations } from "../OrchestratorState.ts";
import { readForMemory } from "../Workspaces.ts";
import { ownerOf, ownersByKey } from "../relay/Facts.ts";

export const threadWorkspace = Effect.fn("Banneret.threadWorkspace")(function* (
  threadId: ThreadId,
  projectId: ProjectId,
  environment: EnvironmentId,
) {
  const project = yield* (yield* ProjectService).getShell(projectId);
  if (Option.isNone(project)) return null;
  const workspaces = yield* readForMemory;
  const designations = yield* readDesignations;
  const claimed = ownerOf(ownersByKey(workspaces), project.value, environment);
  const main = workspaces.find((w) => !w.deleted && designations[w.id]?.main === threadId);
  if (claimed === null || (main && claimed && main.id !== claimed.id)) return null;
  const owner = claimed ?? main;
  const roles = owner && designations[owner.id];
  return {
    owner,
    root: project.value.workspaceRoot,
    projectKey: project.value.repositoryIdentity
      ? projectKeyFromRemote(project.value.repositoryIdentity.locator.remoteUrl)
      : null,
    main: roles?.main === threadId,
    orchestrator: roles?.main === threadId || roles?.projects[projectId] === threadId,
  };
});
