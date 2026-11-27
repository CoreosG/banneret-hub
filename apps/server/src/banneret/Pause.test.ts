import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { makePause } from "./Pause.ts";
import { makePauseStore } from "./PauseStore.ts";

it.effect("keeps the switch and FIFO across database reopen, and stops every running turn", () =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const filename = dir + "/pause.sqlite";
    const sent: string[] = [],
      stopped: string[] = [];
    const projectId = ProjectId.make("project");
    const threadId = ThreadId.make("chat");
    const threads = Layer.mock(ThreadManagementService)({
      hasReceipt: () => Effect.succeed(false),
      getThreadShell: () =>
        Effect.succeed({ id: threadId, projectId } as NonNullable<
          Effect.Success<ReturnType<ThreadManagementService["Service"]["getThreadShell"]>>
        >),
      sendToThread: (input) =>
        Effect.sync(() => {
          sent.push(input.text);
          return { delivery: "queued" } as Effect.Success<
            ReturnType<ThreadManagementService["Service"]["sendToThread"]>
          >;
        }),
      interruptThread: (input) =>
        Effect.sync(() => {
          stopped.push(input.runId!);
          return { type: "no_active_run" } as const;
        }),
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT,run_id TEXT,status TEXT,ordinal INTEGER)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('a','project','First'),('b','project','Second')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('a','first','running',1),('b','second','waiting',2)`;
      const service = yield* makePause;
      yield* service.change({ kind: "pause" });
      expect(stopped).toEqual([]);
      const store = yield* makePauseStore;
      yield* store.hold("a", threadId, projectId, "First", false);
      yield* store.hold("b", threadId, projectId, "Second", true);
    }).pipe(Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename }), threads)));
    yield* Effect.gen(function* () {
      const service = yield* makePause;
      expect(yield* service.status).toMatchObject({ paused: true, held: 2 });
      yield* service.change({ kind: "stopAll" });
      expect(stopped).toEqual(["first", "second"]);
      expect(sent).toEqual([]);
      expect(yield* service.change({ kind: "resume" })).toMatchObject({ paused: false, held: 0 });
      expect(sent).toEqual(["First", "Second"]);
    }).pipe(Effect.provide(Layer.merge(NodeSqliteClient.layer({ filename }), threads)));
  }).pipe(Effect.provide(NodeServices.layer)),
);
