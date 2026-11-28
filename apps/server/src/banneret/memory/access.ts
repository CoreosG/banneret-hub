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
import { BanneretRelayFeed } from "../relay/RelayFeed.ts";
import { soloSkillsEnabled } from "./settings.ts";
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
const hasPluginCapability = (
  owner: { kind: string; id: string } | undefined,
  capability: "memory" | "skills" = "memory",
) =>
  owner?.kind === "solo"
    ? readPlugins(owner.id).pipe(
        Effect.map((plugins) => plugins.some((p) => p.manifest.capabilities.includes(capability))),
      )
    : Effect.succeed(false);

/** What a thread's relay says Banneret does not own; null for a Solo thread or a relay without owners. */
const relayElsewhere = Effect.fn("Banneret.relayElsewhere")(function* (
  owner: { relay?: { origin: string } | undefined } | undefined,
) {
  return owner?.relay ? yield* (yield* BanneretRelayFeed).elsewhere(owner.relay.origin) : null;
});

const ownerOfThread = Effect.fn("Banneret.ownerOfThread")(
  function* (threadId: ThreadId, environment: EnvironmentId) {
    const thread = yield* (yield* ThreadManagementService).getThreadShell(threadId);
    return thread
      ? (yield* threadWorkspace(threadId, thread.projectId, environment))?.owner
      : undefined;
  },
  Effect.catchCause(() => Effect.undefined),
);

/**
 * Whether the Hub offers its own memory, skills or search to a thread's agent. In an Enterprise
 * workspace the relay's owners decide. In a Solo one, a plugin that provides the capability takes it,
 * and the machine's skills switch turns the Hub's skills off. The person's own pages do not ask this.
 */
export const hubServes = Effect.fn("Banneret.serves")(function* (
  threadId: ThreadId,
  environment: EnvironmentId,
  capability: "memory" | "skills" | "search",
) {
  const owner = yield* ownerOfThread(threadId, environment);
  if (owner?.kind === "enterprise") return !(yield* relayElsewhere(owner))?.[capability];
  if (capability === "search") return true;
  if (yield* hasPluginCapability(owner, capability)) return false;
  return capability !== "skills" || (yield* soloSkillsEnabled);
});

/** A skill proposal is stored as a note, so it needs Banneret's memory as well as its skills. */
export const offersSkillProposals = Effect.fn("Banneret.skillProposals")(function* (
  threadId: ThreadId,
  environment: EnvironmentId,
) {
  return (
    (yield* hubServes(threadId, environment, "skills")) &&
    (yield* hubServes(threadId, environment, "memory"))
  );
});
export const memoryAccess = Effect.fn("BanneretMemory.access")(
  function* (
    threadId: ThreadId,
    environment: EnvironmentId,
    capability: "memory" | "skills" = "memory",
  ) {
    const { thread } = yield* (yield* ThreadManagementService).getThreadRecords(threadId, []);
    if (thread.linkOrigin || thread.guestShare || thread.deletedAt || thread.archivedAt)
      return yield* unavailable();
    const workspace = yield* threadWorkspace(threadId, thread.projectId, environment);
    if (!workspace || (yield* hasPluginCapability(workspace.owner, capability)))
      return yield* unavailable();
    const { owner, orchestrator } = workspace;
    let login: string | null = null;
    if (owner?.relay) {
      const status = yield* (yield* BanneretEnrolment).status(owner.relay.origin);
      if (status.state === "configured") login = status.me?.login ?? null;
    }
    if (capability === "skills" && owner?.kind === "enterprise" && !login)
      return yield* unavailable();
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
      function* <T>(run: Parameters<typeof withNotes<T>>[3], mode?: "watcher") {
        yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            withNotes(
              file,
              thread.projectId,
              now,
              run,
              mode === "watcher" ? undefined : repo.schedule,
              mode !== "watcher",
            ),
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
    return {
      open,
      storeId: hash,
      root: thread.worktreePath ?? workspace.root,
      origin: login ? origin : undefined,
      orchestrator,
      main: workspace.main,
      repo,
      enterprise: owner?.kind === "enterprise",
    };
  },
  Effect.mapError(() => unavailable()),
);
