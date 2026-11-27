// @effect-diagnostics nodeBuiltinImport:off - hashes a private store name.
import * as NodeCrypto from "node:crypto";
import { OrchestratorMcpFailure, type ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { readForMemory, workspacesFilePath } from "../Workspaces.ts";
import { readDesignations } from "../OrchestratorState.ts";
import { ownerOf, ownersByKey } from "../relay/Facts.ts";
import { BanneretEnrolment } from "../relay/Enrolment.ts";
import { withNotes } from "./store.ts";

const storeName = (workspace: string | null, login: string | null) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([workspace, login]))
    .digest("hex");

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Private memory is unavailable for this thread.",
  });
export const memoryAccess = Effect.fn("BanneretMemory.access")(
  function* (threadId: ThreadId, environment: EnvironmentId) {
    const { thread } = yield* (yield* ThreadManagementService).getThreadRecords(threadId, []);
    if (thread.linkOrigin || thread.guestShare || thread.deletedAt || thread.archivedAt)
      return yield* unavailable();
    const project = yield* (yield* ProjectService).getShell(thread.projectId);
    if (Option.isNone(project)) return yield* unavailable();
    const workspaces = yield* readForMemory;
    const designations = yield* readDesignations;
    const claimed = ownerOf(ownersByKey(workspaces), project.value, environment);
    const main = workspaces.find((w) => !w.deleted && designations[w.id]?.main === threadId);
    if (claimed === null || (main && claimed && claimed.id !== main.id))
      return yield* unavailable();
    const owner = claimed ?? main;
    const role = owner && designations[owner.id];
    const orchestrator = role?.main === threadId || role?.projects[thread.projectId] === threadId;
    let login: string | null = null;
    if (owner?.relay) {
      const status = yield* (yield* BanneretEnrolment).status(owner.relay.origin);
      if (status.state === "configured") login = status.me?.login ?? null;
    }
    const path = yield* Path.Path;
    const dir = path.join(path.dirname(yield* workspacesFilePath), "memory");
    const hash = storeName(owner?.id ?? null, login);
    const fs = yield* FileSystem.FileSystem;
    const open = Effect.fn("BanneretMemory.open")(
      function* <T>(run: Parameters<typeof withNotes<T>>[3]) {
        yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () => withNotes(path.join(dir, hash + ".sqlite"), thread.projectId, now, run),
          catch: () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not complete memory operation. Check the note key and workspace.",
            }),
        });
      },
      Effect.mapError((e) => (e._tag === "OrchestratorMcpFailure" ? e : unavailable())),
    );
    return { open, orchestrator };
  },
  Effect.mapError(() => unavailable()),
);
