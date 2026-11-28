import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { hubServes, memoryAccess } from "./access.ts";
import { personalMessage } from "./corrections.ts";

export const nudge = Effect.fn("BanneretMemory.nudge")(
  function* (event: OrchestrationV2DomainEvent) {
    const message =
      event.type === "message.updated" && personalMessage(event.payload)
        ? event.payload
        : undefined;
    const ended =
      event.type === "thread.settled" ||
      (event.type === "run.updated" &&
        event.payload.delegatedTaskId &&
        ["completed", "failed", "interrupted"].includes(event.payload.status));
    if (!ended && !message) return;
    const environment = yield* (yield* ServerEnvironment).getEnvironmentId;
    if (!(yield* hubServes(event.threadId, environment, "memory"))) return;
    const access = yield* memoryAccess(event.threadId, environment);
    if (access.orchestrator) yield* access.open((s) => s.nudge(event.threadId, message));
  },
  (effect) => Effect.ignoreCause(effect),
);
