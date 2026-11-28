import { TaskLeaseError, type CallApproval, type ThreadId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { approvalMachine } from "./approvals.ts";
import type { Choice } from "./approvalStore.ts";
const machine = Effect.gen(function* () {
  return yield* approvalMachine(yield* (yield* ServerEnvironment).getEnvironmentId);
});
// These fields are safe to send to the approval card. The saved MCP transport stays on the server.
function card({
  id,
  threadId,
  threadTitle,
  source,
  name,
  args,
  sensitive,
  allowAlways,
  state,
  actor,
  reason,
}: CallApproval): CallApproval {
  return {
    id,
    threadId,
    threadTitle,
    source,
    name,
    args,
    sensitive,
    allowAlways,
    state,
    actor,
    reason,
  };
}
const failure = (e: Error) => new TaskLeaseError({ reason: "failed", detail: e.message });
export const approvalHandlers = (actor: Effect.Effect<string>) => ({
  "plugins.approvals": ({ threadId }: { threadId?: ThreadId | undefined }) =>
    Stream.unwrap(
      machine.pipe(
        Effect.map((m) =>
          m.updates.pipe(
            Stream.mapEffect(() => m.list(threadId).pipe(Effect.map((rows) => rows.map(card)))),
          ),
        ),
      ),
    ).pipe(Stream.mapError(failure)),
  "plugins.decide": Effect.fn(function* ({
    id,
    choice,
    reason,
  }: {
    id: string;
    choice: Choice;
    reason: string;
  }) {
    return card(yield* (yield* machine).decide(id, choice, yield* actor, reason));
  }, Effect.mapError(failure)),
});
