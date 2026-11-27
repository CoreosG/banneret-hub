import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  type ThreadId,
  type RunId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as TextGenerators from "../../textGeneration/TextGenerators.ts";
import { memoryAccess } from "./access.ts";
import { personalMessage } from "./corrections.ts";
import { candidates, reminderPrompt, selectedNotes, failOpen, quote } from "./reminders.ts";
import { readDesignations } from "../OrchestratorState.ts";
import { scanMemory } from "./files.ts";

import { installHook, reminderDelivery, type PromptHook } from "./promptHook.ts";
function activityOf(event: OrchestrationV2DomainEvent) {
  if (event.type === "plan.updated") {
    const plan = event.payload;
    return plan.kind === "proposed_plan" ? plan.markdown : JSON.stringify(plan.steps);
  }
  if (event.type !== "turn-item.updated" || event.payload.status !== "completed") return;
  const item = event.payload;
  switch (item.type) {
    case "command_execution":
      return item.input;
    case "dynamic_tool":
      return item.toolName?.startsWith("banneret_memory_")
        ? undefined
        : item.toolName + " " + JSON.stringify(item.input);
    case "file_change":
      return [item.fileName, ...(item.changes ?? []).map((f) => f.path)].join(" ");
    case "file_search":
      return item.pattern;
    case "web_search":
      return item.patterns?.join(" ");
  }
}

export const setupWatcher = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const generators = yield* TextGenerators.TextGenerators;
  const environment = yield* (yield* ServerEnvironment).getEnvironmentId;
  const check = Effect.fn("BanneretMemory.checkReminder")(
    function* (
      thread: ThreadId,
      run: RunId,
      event: string,
      activity: Effect.Effect<string | undefined>,
      tool: boolean,
    ) {
      const designations = yield* readDesignations;
      if (
        !Object.values(designations).some(
          (role) => role.main === thread || Object.values(role.projects).includes(thread),
        )
      )
        return [];
      const access = yield* memoryAccess(thread, environment);
      if (!access.orchestrator) return [];
      const setting = yield* access.open((s) => s.reminders(thread).setting(), "watcher");
      if (!setting) return [];
      const value = (yield* activity)?.slice(0, 2000);
      if (!value) return [];
      yield* Effect.sync(() => scanMemory(value));
      const { notes, recent } = yield* access.open((s) => {
        const watcher = s.reminders(thread);
        const notes =
          watcher.remaining(run) > 0
            ? candidates(s.list(false), value, watcher.muted()).filter(
                (n) => tool || !watcher.recent(n.key),
              )
            : [];
        return { notes, recent: notes.filter((n) => watcher.recent(n.key)).map((n) => n.key) };
      }, "watcher");
      if (!notes.length) return [];
      const instanceId = ProviderInstanceId.make(setting.generator);
      const runner = yield* generators.runner(instanceId);
      if (!runner) return [];
      const { keys } = yield* runner({
        operation: "generateThreadTitle",
        cwd: ".",
        modelSelection: { instanceId, model: setting.model },
        outputSchema: Schema.Struct({
          keys: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
        }),
        prompt: reminderPrompt(value, notes, recent),
      });
      const authorized = yield* memoryAccess(thread, environment);
      if (!authorized.orchestrator) return [];
      return yield* authorized.open((s) => {
        const watcher = s.reminders(thread);
        const current = watcher.setting();
        if (current?.generator !== setting.generator || current.model !== setting.model) return [];
        return selectedNotes(s.list(false), notes, keys).filter((n) =>
          watcher.fire(run, event, n, recent.includes(n.key)),
        );
      }, "watcher");
    },
    (effect) => failOpen(effect),
  );
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof check>>>();
  const hook: PromptHook = (thread, run, id) =>
    check(
      thread,
      run,
      id,
      engine.getMessagesById(thread, [id]).pipe(
        Effect.map((rows) => {
          const m = rows.get(id);
          return m && personalMessage(m) ? m.text : undefined;
        }),
        Effect.orElseSucceed(() => undefined),
      ),
      false,
    ).pipe(
      Effect.provideContext(context),
      Effect.flatMap((notes) =>
        DateTime.now.pipe(
          Effect.map((now) =>
            notes.map((n) => ({
              key: "memory_" + n.key,
              text: quote(n),
              updatedAt: DateTime.formatIso(now),
            })),
          ),
        ),
      ),
    );
  yield* installHook(hook);
  return Effect.fn("BanneretMemory.afterTool")(
    function* (event: OrchestrationV2DomainEvent) {
      if (event.type !== "plan.updated" && event.type !== "turn-item.updated") return;
      const run = event.payload.runId;
      if (
        !run ||
        (event.type === "turn-item.updated" &&
          (event.payload.status !== "completed" ||
            ![
              "dynamic_tool",
              "command_execution",
              "file_change",
              "web_search",
              "file_search",
            ].includes(event.payload.type)))
      )
        return;
      const notes = yield* check(
        event.threadId,
        run,
        event.payload.id,
        Effect.sync(() => activityOf(event)),
        event.type === "turn-item.updated",
      );
      for (const note of notes) {
        const id = "memory:" + run + ":" + event.payload.id + ":" + note.key;
        const messageId = MessageId.make(id);
        yield* engine
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            messageId,
            threadId: event.threadId,
            text: quote(note),
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            dispatchMode: { type: "steer_active", targetRunId: run },
            notification: {
              source: { kind: "system" },
              outcome: "updated",
              summary: "Rule reminder: " + note.key,
              detail: quote(note),
            },
          })
          .pipe(Effect.provideService(reminderDelivery, messageId));
      }
    },
    (effect) => Effect.ignoreCause(effect),
  );
}).pipe(Effect.provide(TextGenerators.layer));
