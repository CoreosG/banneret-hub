import { readPlugins } from "../plugins/registry.ts";
// @effect-diagnostics nodeBuiltinImport:off - hashes a private store name.
import * as NodeCrypto from "node:crypto";
import { OrchestratorMcpFailure, type ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";

import { workspacesFilePath } from "../Workspaces.ts";
import { threadWorkspace } from "../plugins/workspace.ts";

import { BanneretEnrolment } from "../relay/Enrolment.ts";
import { repoCommands } from "./repoSync.ts";
import { allowsPersonalRepo } from "./gitCopy.ts";
import { isMemoryFileError } from "./files.ts";
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
const hasPluginMemory = (owner: { kind: string; id: string } | undefined) =>
  owner?.kind === "solo"
    ? readPlugins(owner.id).pipe(
        Effect.map((plugins) => plugins.some((p) => p.manifest.capabilities.includes("memory"))),
      )
    : Effect.succeed(false);

export const offersHubMemory = Effect.fn("BanneretMemory.offered")(function* (
  threadId: ThreadId,
  environment: EnvironmentId,
) {
  const workspace = yield* (yield* ThreadManagementService).getThreadShell(threadId).pipe(
    Effect.flatMap((thread) =>
      thread ? threadWorkspace(threadId, thread.projectId, environment) : Effect.succeed(null),
    ),
    Effect.catchCause(() => Effect.succeed(null)),
  );
  return !(yield* hasPluginMemory(workspace?.owner));
});
export const memoryAccess = Effect.fn("BanneretMemory.access")(
  function* (threadId: ThreadId, environment: EnvironmentId) {
    const { thread } = yield* (yield* ThreadManagementService).getThreadRecords(threadId, []);
    if (thread.linkOrigin || thread.guestShare || thread.deletedAt || thread.archivedAt)
      return yield* unavailable();
    const workspace = yield* threadWorkspace(threadId, thread.projectId, environment);
    if (!workspace || (yield* hasPluginMemory(workspace.owner))) return yield* unavailable();
    const { owner, orchestrator } = workspace;
    let login: string | null = null;
    if (owner?.relay) {
      const status = yield* (yield* BanneretEnrolment).status(owner.relay.origin);
      if (status.state === "configured") login = status.me?.login ?? null;
    }
    const path = yield* Path.Path;
    const dir = path.join(path.dirname(yield* workspacesFilePath), "memory");
    const hash = storeName(owner?.id ?? null, login);
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(dir, hash + ".sqlite");
    const enrolment = yield* BanneretEnrolment;
    const origin = owner?.relay?.origin;
    const clock = yield* Clock.Clock;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const repo = repoCommands({
      file,
      now: () => clock.currentTimeMillisUnsafe(),
      delay: (signal) => run(Effect.sleep("1200 millis"), { signal }),
      project: thread.projectId,
      workspace: hash,
      projectFolder: storeName(workspace.projectKey ?? thread.projectId, null),
      enterprise: owner?.kind === "enterprise",
      allowed: async () => {
        if (owner?.kind !== "enterprise") return true;
        if (!origin || !login) return false;
        return run(
          Effect.gen(function* () {
            const relay = yield* enrolment.relay(origin);
            if (!relay) return false;
            const status = yield* relay.status;
            if (status.state !== "configured" || status.me?.login !== login) return false;
            const reply = yield* relay.signedGet("/relay/v1/capabilities");
            return reply.status === 200 && allowsPersonalRepo(reply.body);
          }).pipe(Effect.orElseSucceed(() => false)),
        );
      },
    });
    const open = Effect.fn("BanneretMemory.open")(
      function* <T>(run: Parameters<typeof withNotes<T>>[3]) {
        yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () => withNotes(file, thread.projectId, now, run, repo.schedule),
          catch: (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: isMemoryFileError(error)
                ? error.message
                : "Could not complete memory operation. Check the note key and workspace.",
            }),
        });
      },
      Effect.mapError((e) => (e._tag === "OrchestratorMcpFailure" ? e : unavailable())),
    );
    return { open, orchestrator, repo, enterprise: owner?.kind === "enterprise" };
  },
  Effect.mapError(() => unavailable()),
);
