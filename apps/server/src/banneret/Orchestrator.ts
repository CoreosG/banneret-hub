import { registerWorkflow } from "./memory/workflowHandlers.ts";
import { setupWatcher } from "./memory/watcher.ts";
import { nudge } from "./memory/nudge.ts";
import * as Schema from "effect/Schema";
import {
  CommandId,
  type ProjectId,
  MessageId,
  ThreadId,
  TaskLeaseError,
  type OrchestratorSelection,
  type TaskLeaseTakeInput,
} from "@t3tools/contracts";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { emptyDesignations, readDesignations, saveDesignations } from "./OrchestratorState.ts";
import { projectKeyFromRemote } from "./relay/projectKey.ts";
import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { enterpriseRelayOf } from "./relay/Facts.ts";
import { BanneretEnrolment, relayHash } from "./relay/Enrolment.ts";
import * as Workspaces from "./Workspaces.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const lock = Semaphore.makeUnsafe(1);
const unavailable = (detail: string) => new TaskLeaseError({ reason: "unavailable", detail });

export const clearThreadDesignations = (threadId: ThreadId) =>
  lock.withPermits(1)(
    Effect.gen(function* () {
      const all = yield* readDesignations;
      for (const [workspace, state] of Object.entries(all)) {
        if (state.main !== threadId && !Object.values(state.projects).includes(threadId)) continue;
        yield* saveDesignations(workspace, {
          main: state.main === threadId ? null : state.main,
          projects: Object.fromEntries(
            Object.entries(state.projects).filter(([, id]) => id !== threadId),
          ),
        });
      }
    }),
  );

export const lifecycle = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const afterTool = yield* setupWatcher;
    yield* registerWorkflow;
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.mapEffect(afterTool, { concurrency: 4 }),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        Effect.andThen(
          nudge(event),
          event.type === "thread.settled" ||
            event.type === "thread.archived" ||
            event.type === "thread.deleted"
            ? clearThreadDesignations(event.threadId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not clear thread designation", error),
                ),
              )
            : Effect.void,
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

const launchThread = Effect.fn("BanneretOrchestrator.launchThread")(function* (
  projectId: ProjectId,
  title: string,
  commandId: CommandId,
) {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const { selection: modelSelection } = resolveNewThreadModelSelection({
    defaultSelection: settings.defaultModelSelection,
    fallbackSelection: settings.fallbackModelSelection,
    providers: yield* (yield* ProviderRegistry).getProviders,
    settings,
    projectId,
    now: DateTime.toEpochMillis(yield* DateTime.now),
  });
  if (!modelSelection)
    return yield* unavailable("Choose a default provider and model on this machine.");
  const thread = yield* (yield* ThreadLaunchService).launch({
    commandId,
    projectId,
    title,
    modelSelection,
    runtimeMode: settings.defaultRuntimeMode,
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    createdBy: "user",
    creationSource: "web",
  });
  return thread;
});
const select = Effect.fn("BanneretOrchestrator.select")(function* (input: OrchestratorSelection) {
  const { relayOrigin } = input;
  const view = yield* (yield* BanneretEnrolment).status(relayOrigin);
  if (view.state !== "configured" || !view.me)
    return yield* unavailable("Join this company on this machine first.");
  const { workspaces } = yield* Workspaces.list();
  const workspace = workspaces.find(
    (w) => !w.deleted && w.kind === "enterprise" && w.relay?.origin === relayOrigin,
  );
  if (!workspace) return yield* unavailable("Choose a company workspace.");
  const all = yield* readDesignations;
  const state = all[workspace.id] ?? emptyDesignations;
  const threads = yield* ThreadManagementService;
  const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const projects = (yield* (yield* ProjectService).listShells()).filter(
    (project) => enterpriseRelayOf({ workspaces, project, environmentId })?.origin === relayOrigin,
  );
  const folders = yield* ManagedProjectFolders;
  const valid = Effect.fn(function* (id: ThreadId, projectId?: string) {
    const thread = yield* threads.getThreadShell(id);
    if (
      !thread ||
      thread.archivedAt ||
      thread.deletedAt ||
      thread.settledAt ||
      thread.settledOverride === "settled"
    )
      return false;
    if (!projectId && (yield* folders.isScratchProject(thread.projectId))) return true;
    return projects.some(
      (project) => project.id === thread.projectId && (!projectId || projectId === project.id),
    );
  });
  const currentProjects: Record<string, ThreadId> = {};
  for (const [id, thread] of Object.entries(state.projects))
    if (yield* valid(thread, id)) currentProjects[id] = thread;
  let main = state.main && (yield* valid(state.main)) ? state.main : null;
  if (input.action === "set") {
    if (input.threadId && !(yield* valid(input.threadId, input.projectId)))
      return yield* unavailable("Choose an active thread in this workspace.");
    if (input.projectId) {
      if (input.threadId) currentProjects[input.projectId] = input.threadId;
      else delete currentProjects[input.projectId];
    } else {
      if (
        input.threadId &&
        Object.entries(all).some(([id, s]) => id !== workspace.id && s.main === input.threadId)
      )
        return yield* unavailable("Clear this thread's other company designation first.");
      main = input.threadId;
    }
  }
  if (input.action === "ensure" && !main) {
    const { projectId } = yield* folders.ensureScratchProject;
    const commandId = CommandId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4());
    const thread = yield* launchThread(
      projectId,
      `${view.displayName ?? "Company"} orchestrator`,
      commandId,
    );
    main = thread.threadId;
  }
  const next = { main, projects: currentProjects };
  if (
    input.action !== "get" ||
    main !== state.main ||
    Object.keys(currentProjects).length !== Object.keys(state.projects).length
  )
    yield* saveDesignations(workspace.id, next);
  return next;
});

export const selection = (input: OrchestratorSelection) =>
  lock
    .withPermits(1)(select(input))
    .pipe(Effect.mapError((error) => unavailable(error.message)));

export interface TaskHandoff {
  readonly newThread?: true;
  readonly url: string;
  readonly title: string;
  readonly note: string | null;
  readonly claim: string;
}

export const sendTask = Effect.fn("BanneretOrchestrator.sendTask")(function* (
  input: Pick<TaskLeaseTakeInput, "host" | "scope" | "key" | "relayOrigin" | "handoffTaskId">,
  task: TaskHandoff,
  newSandbox = false,
) {
  const { relayOrigin } = input;
  const current = yield* selection({ relayOrigin, action: "get" });
  const repo = projectKeyFromRemote(`https://${input.host ?? "github.com"}/${input.scope}`);
  const projects = yield* (yield* ProjectService).listShells();
  const project = projects.find(
    (p) =>
      current.projects[p.id] &&
      p.repositoryIdentity &&
      repo &&
      projectKeyFromRemote(p.repositoryIdentity.locator.remoteUrl) === repo,
  );
  const parentId = project
    ? current.projects[project.id]
    : (current.main ?? (yield* selection({ relayOrigin, action: "ensure" })).main);
  const threads = yield* ThreadManagementService;
  const parent = parentId && (yield* threads.getThreadShell(parentId));
  if (!parent) return yield* unavailable("The orchestrator thread could not be opened.");
  const key = relayHash([input.relayOrigin, task.url, task.claim].join("\n"));
  const thread = task.newThread
    ? yield* launchThread(
        parent.projectId,
        task.title,
        CommandId.make("handoff-thread-" + key),
      ).pipe(
        Effect.map((t) => ({ id: t.threadId, title: task.title, projectId: parent.projectId })),
      )
    : parent;
  const payload = yield* encodePayload({
    relayOrigin,
    task: input.handoffTaskId ?? input.key,
    issue: input.key,
    url: task.url,
    title: task.title,
    repository: input.scope,
    lastReleaseNote: task.note,
  });
  const text =
    payload +
    (newSandbox
      ? "\nThe owner chose a new sandbox. Follow the sandbox procedure before claiming."
      : "") +
    `\nUse the ${project ? "banneret_start_task" : "banneret_route_task"} prompt.`;
  yield* threads.sendToThread({
    threadId: thread.id,
    projectId: thread.projectId,
    commandId: CommandId.make("take-" + key),
    messageId: MessageId.make("take-" + key),
    text,
    attachments: [],
    mode: "queue",
    createdBy: "user",
    creationSource: "web",
  });
  return { id: thread.id, title: thread.title };
});
