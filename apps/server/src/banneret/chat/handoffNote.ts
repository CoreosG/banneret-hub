import { checkReleaseComment, type Handoff } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { invalid } from "./AgentChat.ts";

export function handoffNote(note: Handoff["note"]) {
  const text = [
    "Goal: " + note.goal,
    "Done: " + note.done,
    "Next: " + note.next,
    ...(note.risks ? ["Risks: " + note.risks] : []),
  ].join("\n");
  const error = checkReleaseComment({ reason: "handing_over", freeToContinue: true, note: text });
  return error ? Effect.fail(invalid(error)) : Effect.succeed(text);
}
