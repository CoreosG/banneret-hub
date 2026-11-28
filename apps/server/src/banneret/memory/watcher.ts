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
import { providerRules } from "./providerRules.ts";
import { memoryAccess } from "./access.ts";
import { personalMessage } from "./corrections.ts";
import {
  candidates,
  reminderPrompt,
  selectedNotes,
  failOpen,
  selectedReminders,
} from "./reminders.ts";
import { readDesignations } from "../OrchestratorState.ts";
import { scanMemory } from "./files.ts";

import { installHook, reminderDelivery, type PromptHook } from "./promptHook.ts";
function activityOf(event: OrchestrationV2DomainEvent) {
  if (event.type === "plan.updated") {
    const plan = event.payload;
    return plan.kind === "proposed_plan" ? plan.markdown : JSON.stringify(plan.steps);
  }
  if (event.type !== "turn-item.updated") return;
  const item = event.payload;
  switch (item.type) {
    case "assistant_message":
      return item.text;
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
      compareRules: boolean,
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
      const providers =
        compareRules && access.root
          ? yield* Effect.promise(() => providerRules(access.root!, value))
          : [];
      const { keys, conflicts } = yield* runner({
        operation: "generateThreadTitle",
        cwd: ".",
        modelSelection: { instanceId, model: setting.model },
        outputSchema: Schema.Struct({
          conflicts: Schema.Array(Schema.Struct({ a: Schema.String, b: Schema.String })).check(
            Schema.isMaxLength(8),
          ),
          keys: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
        }),
        prompt: reminderPrompt(value, notes, recent, providers),
      });
      const authorized = yield* memoryAccess(thread, environment);
      if (!authorized.orchestrator) return [];
      return yield* authorized.open((s) => {
        const watcher = s.reminders(thread);
        const current = watcher.setting();
        if (current?.generator !== setting.generator || current.model !== setting.model) return [];
        const live = s.list(false);
        const selected = selectedNotes(
          live,
          notes,
          notes.map((n) => n.key),
        );
        return selectedReminders(
          watcher,
          run,
          event,
          selected,
          providers,
          keys,
          compareRules ? conflicts : [],
          recent,
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
      false,
    ).pipe(
      Effect.provideContext(context),
      Effect.flatMap((notes) =>
        DateTime.now.pipe(
          Effect.map((now) =>
            notes.map((n) => ({
              key: "memory_" + n.key,
              text: n.text,
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
          ((event.payload.status !== "completed" &&
            !(
              event.payload.status === "pending" &&
              (event.payload.type === "command_execution" || event.payload.type === "dynamic_tool")
            )) ||
            ![
              "assistant_message",
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
        true,
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
            text: note.text,
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            dispatchMode: { type: "steer_active", targetRunId: run },
            notification: {
              source: { kind: "system" },
              outcome: "updated",
              summary: note.summary,
              detail: note.text,
            },
          })
          .pipe(Effect.provideService(reminderDelivery, messageId));
      }
    },
    (effect) => Effect.ignoreCause(effect),
  );
}).pipe(Effect.provide(TextGenerators.layer));
