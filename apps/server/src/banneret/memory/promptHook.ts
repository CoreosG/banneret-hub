import * as Context from "effect/Context";
import type { ThreadId, RunId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
type ContextNote = { key: string; text: string; updatedAt: string };
export type PromptHook = (
  thread: ThreadId,
  run: RunId,
  message: MessageId,
) => Effect.Effect<ContextNote[]>;
let promptHook: PromptHook | undefined;
export const promptReminders: PromptHook = (thread, run, message) =>
  promptHook?.(thread, run, message) ?? Effect.succeed([]);

export const installHook = (hook: PromptHook) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      promptHook = hook;
    }),
    () =>
      Effect.sync(() => {
        if (promptHook === hook) promptHook = undefined;
      }),
  );

export const reminderDelivery = Context.Reference<MessageId | null>("banneret/ReminderDelivery", {
  defaultValue: () => null,
});
