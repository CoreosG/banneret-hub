// Banneret Hub: which company an agent thread works for (docs/banneret/agents.md). A thread does when its
// project belongs to an Enterprise workspace whose relay this machine has joined. Everything here is read from
// local state: threads, projects, the workspaces file, the enrolment and the feed's last capabilities. So a
// Solo thread, or a machine that never joined, makes no relay call.
import {
  BANNERET_AGENT_TOOLS,
  type ElsewhereOwners,
  OrchestratorMcpFailure,
  toolCapability,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { BanneretEnrolment } from "../relay/Enrolment.ts";
import { enterpriseRelayOf } from "../relay/Facts.ts";
import { BanneretRelayFeed, type RelayMcpTool } from "../relay/RelayFeed.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import { readDesignations } from "../OrchestratorState.ts";
import * as Workspaces from "../Workspaces.ts";

export interface AgentRelay {
  readonly relayOrigin: string;
  readonly company: string;
  /** The person the relay knows this machine as; every lease write is checked against it. */
  readonly me: { readonly login: string; readonly permissions: readonly string[] };
  readonly projectId: ProjectId;
}

/** Every tools/list asks once per agent tool, so the offer is kept this long per thread. */
const OFFER_TTL = Duration.seconds(15);

const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(BANNERET_AGENT_TOOLS);

/**
 * The agent tools the relay enables for this person: named in `mcpTools`, with the required permission.
 * A tool of a capability Banneret does not own is never offered, even if a relay names it.
 */
export const offeredTools = (
  mcpTools: ReadonlyArray<RelayMcpTool>,
  permissions: readonly string[],
  elsewhere: ElsewhereOwners | null = null,
): ReadonlySet<string> =>
  new Set(
    mcpTools
      .filter((tool) => {
        const capability = toolCapability(tool.name);
        return (
          AGENT_TOOL_NAMES.has(tool.name) &&
          !(capability && elsewhere?.[capability]) &&
          // A hand-off passes on a Banneret lease, so it needs tasks as well as chat.
          !(tool.name === "banneret_handoff_offer" && elsewhere?.tasks) &&
          (!tool.requires || permissions.includes(tool.requires))
        );
      })
      .map((tool) => tool.name),
  );

/** Offer inputs as one comparable string. */
const inputsKey = (inputs: ReadonlyArray<unknown>) => JSON.stringify(inputs);

const readFailed = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not read this thread's workspace. Try again.",
  });

export class BanneretAgentRelays extends Context.Service<
  BanneretAgentRelays,
  {
    /** The company the thread works for, read now; null for a Solo thread or a relay not joined. */
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<AgentRelay | null, OrchestratorMcpFailure>;
    /** What Banneret does not own at the thread's company, read now. Null also on any error. */
    readonly elsewhere: (threadId: ThreadId) => Effect.Effect<ElsewhereOwners | null>;
    /** The agent tools offered to the thread, kept briefly. Never fails: on any error nothing is offered. */
    readonly offered: (threadId: ThreadId) => Effect.Effect<ReadonlySet<string>>;
    /**
     * What every offer on this machine is computed from, read from local state only: each Enterprise
     * workspace's relay and projects, its enrolment, and its `mcpTools` once joined. When it changes, an offer
     * may have changed. Undefined when it could not be read.
     */
    readonly offerInputs: Effect.Effect<string | undefined>;
    /** Drops every kept offer, so the next list reads the current one. */
    readonly forgetOffers: Effect.Effect<void>;
  }
>()("t3/banneret/agents/AgentRelays/BanneretAgentRelays") {}

export const makeThreadRelay = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const enrolment = yield* BanneretEnrolment;
  const folders = yield* ManagedProjectFolders;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof Workspaces.list>>>();

  return Effect.fn("BanneretAgentRelays.forThread")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null) return null;
    const project = yield* projects.getShell(thread.projectId);
    if (Option.isNone(project)) return null;
    const { workspaces } = yield* Workspaces.list().pipe(Effect.provideContext(context));
    let relay = enterpriseRelayOf({ workspaces, project: project.value, environmentId });
    if (
      !relay &&
      !thread.archivedAt &&
      !thread.deletedAt &&
      (yield* folders.isScratchProject(thread.projectId))
    ) {
      const roles = yield* readDesignations.pipe(Effect.provideContext(context));
      relay = workspaces.find(
        (w) => !w.deleted && w.kind === "enterprise" && roles[w.id]?.main === threadId,
      )?.relay;
    }
    if (relay === undefined) return null;
    const view = yield* enrolment.status(relay.origin);
    if (view.state !== "configured" || view.me === undefined) return null;
    return {
      relayOrigin: view.relayOrigin,
      company: view.displayName ?? relay.displayName,
      me: view.me,
      projectId: thread.projectId,
    } satisfies AgentRelay;
  }, Effect.mapError(readFailed));
});

export const layer = Layer.effect(
  BanneretAgentRelays,
  Effect.gen(function* () {
    const forThread = yield* makeThreadRelay;
    const feed = yield* BanneretRelayFeed;
    const enrolment = yield* BanneretEnrolment;
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof Workspaces.list>>>();
    const lookupOffer = Effect.fn("BanneretAgentRelays.lookupOffer")(
      function* (threadId: ThreadId) {
        const relay = yield* forThread(threadId);
        if (relay === null) return new Set<string>();
        const tools = yield* feed.mcpTools(relay.relayOrigin);
        return tools === null
          ? new Set<string>()
          : offeredTools(tools, relay.me.permissions, yield* feed.elsewhere(relay.relayOrigin));
      },
      // A failed offer must hide the tools, never fail the list request that asked.
      Effect.catchCause((cause) =>
        Effect.logWarning("Banneret agent offer failed", cause).pipe(Effect.as(new Set<string>())),
      ),
    );
    const offers = yield* Cache.make({
      capacity: 1_000,
      timeToLive: OFFER_TTL,
      lookup: lookupOffer,
    });
    const offered = Effect.fn("BanneretAgentRelays.offered")((threadId: ThreadId) =>
      Cache.get(offers, threadId),
    );

    const offerInputs = Effect.gen(function* () {
      const { workspaces } = yield* Workspaces.list().pipe(Effect.provideContext(context));
      const inputs: Array<unknown> = [yield* readDesignations.pipe(Effect.provideContext(context))];
      for (const workspace of workspaces) {
        if (workspace.kind !== "enterprise" || workspace.relay === undefined || workspace.deleted)
          continue;
        const view = yield* enrolment.status(workspace.relay.origin);
        // Only a joined relay's tools are read, as in forThread, so a machine that never joined asks none.
        const joined = view.state === "configured" && view.me !== undefined;
        inputs.push([
          workspace.relay.origin,
          workspace.projectKeys.toSorted(),
          view.state,
          view.me?.login ?? null,
          view.me?.permissions ?? null,
          joined ? yield* feed.mcpTools(view.relayOrigin) : null,
          // An owner change can leave `mcpTools` alone and still change the Hub's own tools.
          joined ? yield* feed.elsewhere(view.relayOrigin) : null,
        ]);
      }
      return inputsKey(inputs);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Banneret agent offer inputs failed", cause).pipe(Effect.as(undefined)),
      ),
    );

    const elsewhere = Effect.fn("BanneretAgentRelays.elsewhere")(
      function* (threadId: ThreadId) {
        const relay = yield* forThread(threadId);
        return relay === null ? null : yield* feed.elsewhere(relay.relayOrigin);
      },
      Effect.catchCause(() => Effect.succeed(null)),
    );

    return BanneretAgentRelays.of({
      forThread,
      elsewhere,
      offered,
      offerInputs,
      forgetOffers: Cache.invalidateAll(offers),
    });
  }),
);
