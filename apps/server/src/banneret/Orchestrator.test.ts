import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  TASK_LEASE_WS_METHODS,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import {
  ThreadLaunchService,
  type ThreadLaunchResult,
} from "../orchestration-v2/ThreadLaunchService.ts";
import {
  ThreadManagementService,
  type ThreadManagementSendInput,
  type ThreadManagementSendResult,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { clearThreadDesignations, selection } from "./Orchestrator.ts";
import * as Workspaces from "./Workspaces.ts";
import * as LeaseService from "./lease/LeaseService.ts";
import * as CommentEdits from "./lease/CommentEdits.ts";
import {
  commentEdits,
  enrolledAs,
  leaseTrackerLayer,
  ME,
  newTracker,
  ref,
} from "./lease/leaseTracker.testkit.ts";

it.effect(
  "routes a confirmed claim once through the project, the main or a new scratch main",
  () => {
    const messages: ThreadManagementSendInput[] = [];
    const launches: ProjectId[] = [];
    const tracker = newTracker();
    const projectId = ProjectId.make("repo");
    const scratch = ProjectId.make("scratch");
    const first = ThreadId.make("one");
    const second = ThreadId.make("two");
    const main = ThreadId.make("main");
    const created = ThreadId.make("created");
    const modelSelection = liveThreadShell(first).modelSelection;
    const { relayOrigin } = ref;
    const project = {
      id: projectId,
      workspaceRoot: "/repo",
      repositoryIdentity: {
        canonicalKey: "github.com/" + ref.scope,
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/" + ref.scope,
        },
        rootPath: "/repo",
        displayName: ref.scope,
      },
    } as OrchestrationProjectShell;
    const infra = Layer.mergeAll(
      enrolledAs(ME),
      leaseTrackerLayer(tracker),
      Layer.succeed(CommentEdits.CommentEdits, commentEdits(tracker)),
      Layer.mock(ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
      }),
      Layer.mock(ProjectService)({ listShells: () => Effect.succeed([project]) }),
      Layer.mock(ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratch }),
        isScratchProject: (id) => Effect.succeed(id === scratch),
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          defaultModelSelection: modelSelection,
        }),
      }),
      Layer.mock(ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => {
            launches.push(input.projectId);
            expect(input.modelSelection).toEqual(modelSelection);
            return { threadId: created } as ThreadLaunchResult;
          }),
      }),
      Layer.mock(ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed({
            ...liveThreadShell(id),
            projectId: id === created || id === main ? scratch : projectId,
          }),
        sendToThread: (input) =>
          Effect.sync(() => {
            messages.push(input);
            return {} as ThreadManagementSendResult;
          }),
      }),
    );
    const set = (threadId: ThreadId | null, project?: ProjectId) =>
      selection({
        action: "set",
        relayOrigin,
        threadId,
        ...(project ? { projectId: project } : {}),
      });
    const take = LeaseService.rpcHandlers[TASK_LEASE_WS_METHODS.take];
    const release = () =>
      LeaseService.rpcHandlers[TASK_LEASE_WS_METHODS.release]({
        ...ref,
        reason: "handing_over",
        note: "Next: review",
        freeToContinue: true,
      });
    return Effect.gen(function* () {
      yield* Workspaces.put({
        workspaces: [
          {
            id: "company",
            name: "Company",
            kind: "enterprise",
            updatedAt: "2026-11-20T00:00:00Z",
            projectKeys: ["path:local:/repo"],
            relay: { origin: relayOrigin, displayName: "Company" },
          },
        ],
      });
      yield* set(first, projectId);
      expect((yield* set(second, projectId)).projects).toEqual({ repo: second });
      yield* set(first);
      expect((yield* set(main)).main).toBe(main);
      const withHandoff = { ...ref, handoffTaskId: "task-7" };
      expect((yield* take(withHandoff)).orchestratorThreadId).toBe(second);
      yield* release();
      yield* clearThreadDesignations(second);
      expect((yield* selection({ action: "get", relayOrigin })).projects).toEqual({});
      expect((yield* take(withHandoff)).orchestratorThreadId).toBe(main);
      yield* release();
      yield* clearThreadDesignations(main);
      expect((yield* selection({ action: "get", relayOrigin })).main).toBeNull();
      expect((yield* take(ref)).outcome).toBe("taken");
      expect(launches).toEqual([]);
      yield* release();
      expect((yield* take(withHandoff)).orchestratorThreadId).toBe(created);
      expect(launches).toEqual([scratch]);
      expect(messages.map((m) => m.threadId)).toEqual([second, main, created]);
      expect(messages.map((m) => m.mode)).toEqual(["queue", "queue", "queue"]);
      expect(messages[0]?.text).toContain("banneret_start_task");
      expect(messages[2]?.text).toContain("banneret_route_task");
      expect(messages[2]?.text).toContain("Next: review");
    }).pipe(
      Effect.provide(
        LeaseService.layerWith({ readBackDelay: 0 }).pipe(
          Layer.provideMerge(infra),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "take-routing-" })),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    );
  },
);
