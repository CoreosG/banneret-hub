import type { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { promptReminders } from "../memory/promptHook.ts";
import { answeringAsk } from "./AnswerTurn.ts";

/** A resumed turn already carries its reminders. */
export const turnReminders = (turn: {
  readonly resume?: boolean;
  readonly run: { readonly threadId: ThreadId; readonly id: RunId };
  readonly message: { readonly messageId: MessageId };
}) =>
  turn.resume
    ? Effect.succeed([])
    : promptReminders(turn.run.threadId, turn.run.id, turn.message.messageId);

export function answerPolicy(message: string, policy: ProviderAdapterV2RuntimePolicy) {
  if (!answeringAsk(message)) return {};
  return {
    runtimePolicy: {
      ...policy,
      runtimeMode: "approval-required" as const,
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
    },
  };
}
