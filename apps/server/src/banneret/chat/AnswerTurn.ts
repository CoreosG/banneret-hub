import { ThreadId, type AgentAskPolicy, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ThreadManagementServiceShape } from "../../orchestration-v2/ThreadManagementService.ts";

import { handleId } from "./AgentChat.ts";
export const reviewThreadId = (origin: string, ask: string) =>
  ThreadId.make("review-" + handleId(origin + "/" + ask));

export const answerMessageId = (ask: string, delivery: string) =>
  "agent-ask:" + ask + ":" + delivery;
export const answeringAsk = (messageId: string) =>
  /^agent-ask:([\w-]+):[\w-]+$/.exec(messageId)?.[1];

export const activeRun = Effect.fn(function* (
  threads: ThreadManagementServiceShape,
  thread: ThreadId,
) {
  const active = (yield* threads.getThreadShell(thread))?.activeRunId;
  if (!active) return undefined;
  return (yield* threads.getThreadRecords(thread, ["runs"], { runIds: [active] })).runs[0];
});

export function capReached(
  usage: { tokens: number; seconds: number },
  cap: Pick<AgentAskPolicy, "maxTokens" | "maxSeconds">,
) {
  if (usage.tokens >= cap.maxTokens) return "token_cap";
  if (usage.seconds >= cap.maxSeconds) return "time_cap";
}

export const runUsage = Effect.fn(function* (
  threads: ThreadManagementServiceShape,
  run: OrchestrationV2Run,
) {
  const active =
    run.activeAttemptId &&
    (yield* threads.getThreadRecords(run.threadId, ["attempts"], {
      attemptIds: [run.activeAttemptId],
    })).attempts[0];
  const attempts =
    active?.attemptOrdinal === 1
      ? [active]
      : (yield* threads.getThreadRecords(run.threadId, ["attempts"])).attempts.filter(
          (a) => a.runId === run.id,
        );
  const { providerTurns } = yield* threads.getThreadRecords(run.threadId, ["providerTurns"], {
    providerTurnAttemptIds: attempts.map((a) => a.id),
  });
  // tokenUsage describes the context window. Only turnTokenUsage belongs to this ask.
  const tokens = providerTurns.reduce(
    (sum, { turnTokenUsage: t }) =>
      sum +
      (t?.inputTokens ?? 0) +
      (t?.outputTokens ?? 0) +
      (t?.otherUsage?.inputTokens ?? 0) +
      (t?.otherUsage?.outputTokens ?? 0),
    0,
  );
  const end = run.completedAt
    ? DateTime.toEpochMillis(run.completedAt)
    : yield* Clock.currentTimeMillis;
  const seconds = run.startedAt
    ? Math.max(0, Math.floor((end - DateTime.toEpochMillis(run.startedAt)) / 1000))
    : 0;
  return { tokens, seconds };
});

export const runReceipt = Effect.fn(function* (
  threads: ThreadManagementServiceShape,
  run: OrchestrationV2Run,
  handle: string,
) {
  const usage = yield* runUsage(threads, run);
  const { turnItems } = yield* threads.getThreadRecords(run.threadId, ["turnItems"], {
    turnItemRunIds: [run.id],
    turnItemTypes: [
      "dynamic_tool",
      "command_execution",
      "file_change",
      "file_search",
      "web_search",
    ],
  });
  const tools = turnItems.map((item) =>
    item.type === "dynamic_tool" ? (item.toolName ?? item.type) : item.type,
  );
  return { handle, ...usage, tools: [...new Set(tools)] };
});
