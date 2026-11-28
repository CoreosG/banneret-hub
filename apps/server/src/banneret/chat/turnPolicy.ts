import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { answeringAsk } from "./AnswerTurn.ts";
export { promptReminders } from "../memory/promptHook.ts";

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
