import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { useQuietThreadShell } from "../state/entities";
import { selectOrchestrator, useOrchestrators } from "./orchestratorStore";
import { relayKey } from "./enrolmentStore";

export function useRefreshInactiveDesignation(
  shell: ReturnType<typeof useQuietThreadShell>,
  environmentId: EnvironmentId | undefined,
  relayOrigin: string | undefined,
) {
  const inactive = Boolean(
    shell?.archivedAt || shell?.settledAt || shell?.settledOverride === "settled",
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a settlement or archive invalidates the designation cached by this window
  useEffect(() => {
    if (inactive && environmentId && relayOrigin)
      void selectOrchestrator({ environmentId, relayOrigin }, { action: "get", relayOrigin });
  }, [inactive, environmentId, relayOrigin]);
  return inactive;
}

export function OrchestratorMarker({ thread }: { thread: ScopedThreadRef }) {
  const prefix = relayKey({ environmentId: thread.environmentId, relayOrigin: "" });
  const key = useOrchestrators(
    (state) =>
      Object.entries(state.byRelay).find(
        ([key, state]) =>
          key.startsWith(prefix) && Object.values(state.projects).includes(thread.threadId),
      )?.[0],
  );
  const shell = useQuietThreadShell(key ? thread : null);
  const inactive = useRefreshInactiveDesignation(
    shell,
    thread.environmentId,
    key?.slice(prefix.length),
  );
  return key && !inactive ? (
    <small className="ml-1 text-muted-foreground">Project orchestrator</small>
  ) : null;
}
