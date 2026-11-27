import type { ScopedThreadRef } from "@t3tools/contracts";
import { useOrchestrators } from "./orchestratorStore";
import { relayKey } from "./enrolmentStore";

export function OrchestratorMarker({ thread }: { thread: ScopedThreadRef }) {
  const prefix = relayKey({ environmentId: thread.environmentId, relayOrigin: "" });
  const selected = useOrchestrators((state) =>
    Object.entries(state.byRelay).some(
      ([key, state]) =>
        key.startsWith(prefix) && Object.values(state.projects).includes(thread.threadId),
    ),
  );
  return selected ? (
    <small className="ml-1 text-muted-foreground">Project orchestrator</small>
  ) : null;
}
