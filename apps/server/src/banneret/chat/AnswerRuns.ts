import * as Clock from "effect/Clock";
import {
  ChatAsks,
  ChatSettings,
  CommandId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { RelayEnrolment } from "../relay/Enrolment.ts";
import { capReached, runReceipt, runUsage } from "./AnswerTurn.ts";

const decodeSettings = Schema.decodeUnknownEffect(ChatSettings);
const decodeAsks = Schema.decodeUnknownEffect(ChatAsks);
const live = new Set(["preparing", "queued", "starting", "running", "waiting"]);
interface Row {
  origin: string;
  ask: string;
  handle: string;
  thread: string;
  project: string;
  run: string;
  maxTokens: number;
  maxSeconds: number;
  expires: number;
}

// Relay open + pending delivery -> dispatch with a stable command id, save the run, consume.
// The run projection owns queued/answering. A finished or missing run closes its open ask.
// Closed remotely or over budget -> interrupt that exact run. Restart resumes from the saved row.
export const makeAnswerRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  yield* sql`CREATE TABLE IF NOT EXISTS banneret_answer_runs (origin TEXT, ask TEXT, handle TEXT, thread TEXT, project TEXT, run TEXT, maxTokens INTEGER, maxSeconds INTEGER, expires INTEGER, PRIMARY KEY(origin,ask))`.pipe(
    Effect.orDie,
  );
  const policy = (relay: RelayEnrolment) =>
    relay.signedChat("GET", "me/settings").pipe(
      Effect.flatMap((r) => decodeSettings(r.body)),
      Effect.map((s) => s.agentAsks),
    );
  const remember = (
    relay: RelayEnrolment,
    ask: string,
    handle: string,
    expires: string,
    run: Pick<OrchestrationV2Run, "id" | "threadId">,
    project: ProjectId,
    caps: { maxTokens: number; maxSeconds: number },
  ) =>
    sql`INSERT OR IGNORE INTO banneret_answer_runs VALUES (${relay.origin},${ask},${handle},${run.threadId},${project},${run.id},${caps.maxTokens},${caps.maxSeconds},${Date.parse(expires)})`.pipe(
      Effect.orDie,
    );

  const check = Effect.fn(function* (relay: RelayEnrolment, row: Row, closed: boolean) {
    const threadId = ThreadId.make(row.thread);
    const runId = RunId.make(row.run);
    const run = (yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] })).runs[0];
    const running = run && live.has(run.status);
    const reason = running ? capReached(yield* runUsage(threads, run), row) : "turn_ended";
    if (!closed && !reason && (yield* Clock.currentTimeMillis) < row.expires) return;
    if (running)
      yield* threads.interruptThread({
        threadId,
        projectId: ProjectId.make(row.project),
        runId,
        commandId: CommandId.make("stop-ask:" + row.ask),
      });
    if (!closed)
      yield* relay
        .signedChat("POST", "asks/" + row.ask + "/answer", {
          none: true,
          asHandle: row.handle,
          reason: reason ?? "expired",
          receipt: run && (yield* runReceipt(threads, run, row.handle)),
        })
        .pipe(
          Effect.catchIf(
            (e) => e.code === "ask_closed",
            () => Effect.void,
          ),
        );
    yield* sql`DELETE FROM banneret_answer_runs WHERE origin=${row.origin} AND ask=${row.ask}`.pipe(
      Effect.orDie,
    );
  });
  const rows = (relay: RelayEnrolment) =>
    sql<Row>`SELECT * FROM banneret_answer_runs WHERE origin=${relay.origin}`.pipe(Effect.orDie);
  const reconcile = Effect.fn(function* (relay: RelayEnrolment, remote: boolean) {
    const local = yield* rows(relay);
    if (!local.length) return;
    const open = new Set<string>();
    if (remote) {
      let cursor: string | null = null;
      do {
        const page: ChatAsks = yield* relay
          .signedChat(
            "GET",
            "asks?role=answerer&state=open&limit=100" +
              (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          )
          .pipe(Effect.flatMap((r) => decodeAsks(r.body)));
        for (const ask of page.items) open.add(ask.id);
        cursor = page.nextCursor;
      } while (cursor);
    }
    for (const row of local)
      yield* check(relay, row, remote && !open.has(row.ask)).pipe(
        Effect.catchCause((c) => Effect.logWarning("Could not reconcile an answer turn", c)),
      );
  });
  return { remember, policy, reconcile, rows };
});
