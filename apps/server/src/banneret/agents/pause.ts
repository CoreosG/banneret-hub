import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { threadWorkspace } from "../plugins/workspace.ts";

export const mayPause = Effect.fn("BanneretPause.mayPause")(
  function* (id: ThreadId, environment: EnvironmentId) {
    const { thread } = yield* (yield* ThreadManagementService).getThreadRecords(id, []);
    if (thread.deletedAt || thread.archivedAt || thread.linkOrigin || thread.guestShare)
      return false;
    return (yield* threadWorkspace(id, thread.projectId, environment))?.orchestrator === true;
  },
  Effect.orElseSucceed(() => false),
);
