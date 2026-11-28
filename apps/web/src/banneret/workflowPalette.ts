// The command palette's "Review my workflow": find the main orchestrator chat, open it, run there.
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { toastManager } from "../components/ui/toast";
import type { RelayTarget } from "./enrolmentStore";
import { selectOrchestrator } from "./orchestratorStore";
import { workflowAction } from "./WorkflowReview";

export async function reviewMyWorkflow(
  target: RelayTarget,
  open: (ref: ScopedThreadRef) => Promise<unknown>,
) {
  const roles = await selectOrchestrator(target, {
    action: "get",
    relayOrigin: target.relayOrigin,
  });
  if (!roles?.main) {
    toastManager.add({
      type: "error",
      title: roles
        ? "Choose a main orchestrator first"
        : "Could not find your main orchestrator chat",
      ...(roles && {
        description: "Open a chat's menu and choose Use as my main orchestrator.",
      }),
    });
    return;
  }
  const ref = { environmentId: target.environmentId, threadId: ThreadId.make(roles.main) };
  await open(ref);
  await workflowAction(ref, "run").catch(() =>
    toastManager.add({ type: "error", title: "Could not run the workflow review." }),
  );
}
