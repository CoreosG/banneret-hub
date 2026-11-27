import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import { makePauseStore } from "./PauseStore.ts";
const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("skips automatic task dispatch while this machine is paused", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const pause = yield* makePauseStore;
      const task = yield* service.upsert(
        yield* decodeInput({
          commandId: "paused-task",
          title: "Review",
          prompt: "Review changes",
          enabled: true,
          schedule: { type: "interval", everyMs: 60000 },
          projectId: "project",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      );
      yield* pause.set(true);
      yield* TestClock.adjust("65 seconds");
      expect((yield* service.list()).tasks[0]?.runCount).toBe(0);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(task.task.nextRunAt);
      yield* pause.set(false);
      yield* TestClock.adjust("6 seconds");
      expect((yield* service.list()).tasks[0]?.runCount).toBe(1);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
