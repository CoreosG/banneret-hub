import { TaskLeaseError, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { readDesignations } from "../OrchestratorState.ts";
import { makePauseStore } from "../PauseStore.ts";
import { hubServes, memoryAccess, unavailable } from "./access.ts";
import { dispatchWorkflowReview, readWorkflowJudgment } from "./workflowModel.ts";
import { memoryEnabled } from "./settings.ts";

const mainThreads = readDesignations.pipe(
  Effect.map((roles) => [
    ...new Set(Object.values(roles).flatMap((role) => (role.main ? [role.main] : []))),
  ]),
);
const accessMain = Effect.fn(function* (id: ThreadId) {
  const environment = yield* (yield* ServerEnvironment).getEnvironmentId;
  if (!(yield* hubServes(id, environment, "memory"))) return yield* unavailable();
  const access = yield* memoryAccess(id, environment);
  if (!access.main || (access.enterprise && !access.origin)) return yield* unavailable();
  return access;
});
type Action =
  | "read"
  | "run"
  | "enable"
  | "disable"
  | "dismiss"
  | "propose"
  | "setup"
  | "rule"
  | "scheduled";
const workflow = Effect.fn(function* (threadId: ThreadId, action: Action, created?: number) {
  const access = yield* accessMain(threadId);
  let retries = 0;
  let failures = 0;
  let waiting = 0;
  if (
    action === "run" ||
    (action === "scheduled" && (yield* access.open((s) => s.workflow(threadId).due(), "watcher")))
  ) {
    const threads = yield* ThreadManagementService;
    const roles = Object.values(yield* readDesignations).find((r) => r.main === threadId);
    const environment = yield* (yield* ServerEnvironment).getEnvironmentId;
    for (const id of new Set([threadId, ...Object.values(roles?.projects ?? {})])) {
      const owned =
        id === threadId
          ? access
          : yield* memoryAccess(id, environment).pipe(Effect.orElseSucceed(() => null));
      if (!owned || owned.storeId !== access.storeId) continue;
      const { attempts, turnItems } = yield* threads.getThreadRecords(
        id,
        ["attempts", "turnItems"],
        { turnItemTypes: ["command_execution", "dynamic_tool", "approval_request"] },
      );
      retries += attempts.filter(
        (a) => a.reason === "retry" || a.reason === "provider_recovery",
      ).length;
      for (const item of turnItems) {
        if (item.type === "approval_request" && item.startedAt && item.completedAt)
          waiting += Math.max(
            0,
            DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt),
          );
        else if (
          item.status === "failed" ||
          (item.type === "command_execution" && item.exitCode != null && item.exitCode !== 0)
        )
          failures++;
      }
    }
    if ((yield* accessMain(threadId)).storeId !== access.storeId) return yield* unavailable();
  } else if (action === "scheduled") return { weekly: false, report: null };
  const state = yield* access.open((s) => {
    const w = s.workflow(threadId);
    if (action === "enable" || action === "disable") w.schedule(action === "enable");
    if (action === "dismiss" && created !== undefined) w.dismiss(created);
    const report =
      action === "run" || action === "scheduled"
        ? w.run(s, retries, action === "scheduled", failures, waiting)
        : w.current();
    return { relayOrigin: access.origin, weekly: w.weekly(), report };
  }, "watcher");
  const report = state.report;
  if (!report) return state;
  if (action === "run" || action === "scheduled") {
    yield* dispatchWorkflowReview(threadId, access.storeId, report);
    return state;
  }
  const model = yield* readWorkflowJudgment(threadId, access.storeId, report);
  if (action === "propose" || action === "setup" || action === "rule") {
    const fallback =
      action === "propose" &&
      !model.judgment &&
      !model.reviewing &&
      (report.retries || report.failures);
    const text = fallback
      ? "Before retrying a failed agent run, identify the cause and change the next attempt."
      : action === "propose"
        ? null
        : model.judgment?.[action];
    if (!text || created !== report.created) return yield* unavailable();
    const key = fallback ? "workflow-retries" : `workflow-${action}-${created}`;
    yield* access.open((s) => {
      if (s.workflow(threadId).current()?.created !== created) throw new Error("Review changed.");
      if (!s.list(false).some((n) => n.key === key && n.source === "Workflow review"))
        s.propose({ key, text, source: "Workflow review", scope: "project", kind: "feedback" });
    }, "watcher");
  }
  return { ...state, report: { ...report, ...model } };
});
const failed = () =>
  new TaskLeaseError({
    reason: "unavailable",
    detail: "Review is available in your private main orchestrator chat.",
  });
export const workflowHandlers = {
  "memory.workflow": Effect.fn(function* (input: {
    threadId: ThreadId;
    action: Exclude<Action, "scheduled">;
    created?: number | undefined;
  }) {
    return yield* workflow(input.threadId, input.action, input.created);
  }, Effect.mapError(failed)),
  "memory.workflowNeeds": Effect.fn(function* ({ workspaceId }: { workspaceId: string }) {
    const id = (yield* readDesignations)[workspaceId]?.main;
    if (!id) return null;
    const access = yield* accessMain(id);
    return (yield* access.open((s) => s.workflow(id).current()?.pending, "watcher")) ? id : null;
  }, Effect.mapError(failed)),
};
export const registerWorkflow = Effect.gen(function* () {
  let next = 0;
  const pause = yield* makePauseStore;
  yield* (yield* Scheduler.Scheduler).register(
    "weekly-workflow-review",
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now < next) return;
      next = now + 60000;
      if (!(yield* memoryEnabled)) return;
      yield* pause.whenRunning(
        Effect.forEach(yield* mainThreads, (id) => workflow(id, "scheduled").pipe(Effect.ignore), {
          discard: true,
        }),
        Effect.void,
      );
    }),
  );
}).pipe(Effect.provide(Scheduler.layer));
