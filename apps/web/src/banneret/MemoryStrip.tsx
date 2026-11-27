import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useChatRead } from "./chat/client";
import { useOrchestrators } from "./orchestratorStore";
import { relayKey } from "./enrolmentStore";
import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

const summary = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "banneret:memory-summary",
  tag: "memory.summary",
});

export function MemoryStrip({ environmentId, threadId }: ScopedThreadRef) {
  const allowed = useAtomValue(summary.permissionAtom(environmentId));
  const prefix = relayKey({ environmentId, relayOrigin: "" });
  const designated = useOrchestrators((state) =>
    Object.entries(state.byRelay).some(
      ([k, v]) =>
        k.startsWith(prefix) &&
        (v.main === threadId || Object.values(v.projects).includes(threadId)),
    ),
  );
  const [revision, refresh] = useState(0);
  const state = useChatRead(async () => {
    if (!allowed) return null;
    const result = await runAtomCommand(appAtomRegistry, summary, {
      environmentId,
      input: { threadId },
    });
    return result._tag === "Success" ? result.value : null;
  }, [environmentId, threadId, allowed, designated, revision].join(":"));
  const counts = state.value;
  const visible = allowed && counts != null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- other chats can change these server counts while this thread is idle
  useEffect(() => {
    if (!visible) return;
    const tick = () => {
      if (document.visibilityState === "visible") refresh((n) => n + 1);
    };
    const timer = window.setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [visible]);
  return visible ? (
    <p className="border-b px-4 py-1 text-xs text-muted-foreground">
      Memory · {counts.total} notes · {counts.proposed} proposed · {counts.disputed} disputed ·
      Unencrypted
    </p>
  ) : null;
}
