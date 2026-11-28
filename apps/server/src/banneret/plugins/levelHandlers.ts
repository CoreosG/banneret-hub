import { TaskLeaseError, type ToolLevel, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { pluginsForThread } from "./session.ts";
import { levelFor, pluginSource, setLevel, toolkitSource } from "./levels.ts";

const sources = Effect.fn(function* (thread: ThreadId) {
  const plugins = yield* pluginsForThread(
    (yield* (yield* ThreadManagementService).getThreadRecords(thread, [])).thread,
    yield* (yield* ServerEnvironment).getEnvironmentId,
  );
  return [toolkitSource, ...plugins.map((p) => pluginSource(p.manifest.source))];
});
const rows = (thread: ThreadId, available: string[]) =>
  Effect.forEach(available, (source) =>
    Effect.map(levelFor(thread, source), (level) => ({ source, level })),
  );
const failure = () =>
  new TaskLeaseError({ reason: "failed", detail: "Could not access thread tool levels." });
export const levelHandlers = {
  "plugins.levels": Effect.fn(function* ({ threadId }: { threadId: ThreadId }) {
    return yield* rows(threadId, yield* sources(threadId));
  }, Effect.mapError(failure)),
  "plugins.setLevel": Effect.fn(function* ({
    threadId,
    source,
    level,
  }: {
    threadId: ThreadId;
    source: string;
    level: ToolLevel;
  }) {
    const available = yield* sources(threadId);
    if (!available.includes(source)) return yield* failure();
    yield* setLevel(threadId, source, level);
    return yield* rows(threadId, available);
  }, Effect.mapError(failure)),
};
