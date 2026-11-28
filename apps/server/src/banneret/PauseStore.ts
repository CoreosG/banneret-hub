import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { WorkflowInputError } from "../workflows/Workflows.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";

// Saved switch | pause / Stop all -> paused | resume -> running | restart -> saved value.
// FIFO in SQLite | paused delivery -> append | running + receipt -> remove head.
// A process-local lock orders changes. Stable command ids cover a crash before dequeue.
// Starts may proceed together. A switch change waits for all admitted starts to finish dispatch.
const permits = 1024;
const gate = Semaphore.makeUnsafe(permits);
export const admission = gate.withPermits(permits);
const dispatch = gate.withPermits(1);
export const makePauseStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS banneret_pause (singleton INTEGER PRIMARY KEY)`.pipe(
    Effect.orDie,
  );
  yield* sql`CREATE TABLE IF NOT EXISTS banneret_held (id TEXT NOT NULL UNIQUE, thread TEXT NOT NULL, project TEXT NOT NULL, body TEXT NOT NULL, owner INTEGER NOT NULL)`.pipe(
    Effect.orDie,
  );
  const paused = sql`SELECT 1 FROM banneret_pause LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.orDie,
  );
  const held = sql<{ count: number }>`SELECT count(*) AS count FROM banneret_held`.pipe(
    Effect.map((r) => Number(r[0]?.count ?? 0)),
    Effect.orDie,
  );
  const set = (value: boolean) =>
    (value
      ? sql`INSERT OR IGNORE INTO banneret_pause VALUES (1)`
      : sql`DELETE FROM banneret_pause`
    ).pipe(Effect.asVoid, Effect.orDie);
  const hold = (id: string, thread: string, project: string, body: string, owner: boolean) =>
    sql`INSERT OR IGNORE INTO banneret_held VALUES (${id},${thread},${project},${body},${Number(owner)})`.pipe(
      Effect.asVoid,
      Effect.orDie,
    );
  const drain = Effect.fn("BanneretPause.drain")(function* (
    threads: Pick<ThreadManagementServiceShape, "getThreadShell" | "sendToThread" | "hasReceipt">,
  ) {
    if (yield* paused) return;
    const rows = yield* sql<{
      id: string;
      thread: string;
      project: string;
      body: string;
      owner: number;
    }>`SELECT * FROM banneret_held ORDER BY rowid`.pipe(Effect.orDie);
    for (const row of rows) {
      const commandId = CommandId.make(row.id);
      const threadId = ThreadId.make(row.thread);
      const target = yield* threads.getThreadShell(threadId);
      if (
        target &&
        !target.deletedAt &&
        !target.archivedAt &&
        target.projectId === row.project &&
        !(yield* threads.hasReceipt(commandId))
      ) {
        yield* threads.sendToThread({
          threadId,
          projectId: ProjectId.make(row.project),
          commandId,
          messageId: MessageId.make(row.id),
          text: row.body,
          attachments: [],
          mode: "queue",
          createdBy: row.owner ? "user" : "agent",
          creationSource: "server",
        });
      }
      yield* sql`DELETE FROM banneret_held WHERE id=${row.id}`.pipe(Effect.orDie);
    }
  });
  const whenRunning = <A, E, R, B, F, S>(
    work: Effect.Effect<A, E, R>,
    skipped: Effect.Effect<B, F, S>,
  ) =>
    dispatch(
      Effect.flatMap(paused, (stopped): Effect.Effect<A | B, E | F, R | S> =>
        stopped ? skipped : work,
      ),
    );
  const reason = "Automatic work is paused.";
  const hookStart = <A, E, R>(start: Effect.Effect<A, E, R>) =>
    whenRunning(start, Effect.fail(new WorkflowInputError({ problem: reason })));
  // A manual run ignores the pause. A paused webhook delivery fails with the caller's skip error;
  // any other paused trigger reports that it started nothing.
  const scheduledRun = <A, E, R, T, F>(
    trigger: string,
    run: Effect.Effect<A, E, R>,
    task: T,
    WebhookSkip: (new (props: { reason: string }) => F) | undefined,
  ) =>
    trigger === "manual"
      ? run
      : whenRunning(
          run,
          Effect.suspend(() =>
            WebhookSkip
              ? Effect.fail(new WebhookSkip({ reason }))
              : Effect.succeed({ task, threadId: null, dispatchFailed: false }),
          ),
        );
  return { paused, held, set, hold, drain, whenRunning, hookStart, scheduledRun };
});
