import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { isMemoryFileError, scanMemory } from "./files.ts";

export const personalMessage = (m: OrchestrationV2ConversationMessage) =>
  m.role === "user" &&
  m.createdBy === "user" &&
  (m.creationSource === "web" || m.creationSource === "mobile") &&
  !m.scheduledTaskId &&
  !m.senderThreadId &&
  !m.linkedSender &&
  !m.workflowScript &&
  !m.notification &&
  !m.idleCompaction &&
  !m.delegatedCompletion;

export function sentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && s.length <= 400);
}
export function correctives(text: string) {
  return sentences(text)
    .filter((s) =>
      /^(?:please\s+)?(?:always|never|stop|don['’]t|do not|instead|remember to|use|avoid|make sure)\b/i.test(
        s,
      ),
    )
    .filter((s) => {
      try {
        scanMemory(s);
        return true;
      } catch (error) {
        if (isMemoryFileError(error)) return false;
        throw error;
      }
    });
}
export function sameRule(a: string, b: string) {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/don['’]t/g, "do not")
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((w) => w !== "please"),
    );
  const x = words(a),
    y = words(b);
  for (const polarity of ["not", "never", "stop", "avoid", "always"])
    if (x.has(polarity) !== y.has(polarity)) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.78;
}
