import {
  CommandId,
  type PauseAction,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ACTIVE_RUN_STATUSES,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { admission, makePauseStore } from "./PauseStore.ts";

export const makePause = Effect.gen(function* () {
  const store = yield* makePauseStore;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  // Include side chats and quiet provider runs that the sidebar omits.
  const running = sql<{ threadId: ThreadId; runId: RunId; projectId: ProjectId; title: string }>`
    SELECT r.thread_id AS threadId, r.run_id AS runId, t.project_id AS projectId, t.title
    FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_threads t ON r.thread_id=t.thread_id
    WHERE r.status IN ${sql.in(ACTIVE_RUN_STATUSES)} ORDER BY r.thread_id,r.ordinal
  `.pipe(Effect.orDie);
  const status = Effect.gen(function* () {
    const paused = yield* store.paused;
    return { paused, held: yield* store.held, running: paused ? yield* running : [] };
  });
  const change = (action: PauseAction) =>
    admission(
      Effect.gen(function* () {
        if (action.kind !== "stop") yield* store.set(action.kind !== "resume");
        if (action.kind === "resume")
          yield* store.drain(threads).pipe(Effect.onError(() => store.set(true)));
        if (action.kind === "stop" || action.kind === "stopAll") {
          const targets = (yield* running).filter(
            (r) =>
              action.kind === "stopAll" ||
              (action.kind === "stop" &&
                r.threadId === action.threadId &&
                r.runId === action.runId),
          );
          const outcomes = yield* Effect.forEach(targets, (r) =>
            threads
              .interruptThread({ ...r, commandId: CommandId.make("pause-stop-" + r.runId) })
              .pipe(Effect.result),
          );
          for (const outcome of outcomes)
            if (outcome._tag === "Failure") return yield* outcome.failure;
        }
        return yield* status;
      }),
    );
  return { status, change };
});
export const pauseRpcHandlers = Effect.gen(function* () {
  const service = yield* makePause;
  return {
    "banneretPause.status": () => service.status,
    "banneretPause.change": (action: PauseAction) => service.change(action).pipe(Effect.orDie),
  };
});
