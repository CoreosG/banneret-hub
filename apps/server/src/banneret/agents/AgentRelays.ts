// Banneret Hub: which company an agent thread works for (docs/banneret/agents.md). A thread does when its
// project belongs to an Enterprise workspace whose relay this machine has joined. Everything here is read from
// local state: threads, projects, the workspaces file, the enrolment and the feed's last capabilities. So a
// Solo thread, or a machine that never joined, makes no relay call.
import {
  BANNERET_AGENT_TOOLS,
  OrchestratorMcpFailure,
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
import * as Workspaces from "../Workspaces.ts";

export interface AgentRelay {
  readonly relayOrigin: string;
  readonly company: string;
  /** The person the relay knows this machine as; every lease write is checked against it. */
  readonly me: { readonly login: string; readonly role: string };
  readonly projectId: ProjectId;
}

/** Every tools/list asks once per agent tool, so the offer is kept this long per thread. */
const OFFER_TTL = Duration.seconds(15);

const ROLE_RANK: Readonly<Record<string, number>> = { limited_staff: 0, founder: 1 };

/**
 * Whether a person may call a tool named for `toolRole`, the lowest role that may. Roles are an open set: a
 * person's unknown role counts as `limited_staff`, and a tool's unknown role admits only that exact role.
 */
const roleAllows = (toolRole: string, role: string) => {
  const needed = ROLE_RANK[toolRole];
  return needed === undefined ? toolRole === role : (ROLE_RANK[role] ?? 0) >= needed;
};

const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(BANNERET_AGENT_TOOLS);

/** The agent tools the relay enables for this person: named in `mcpTools`, at or below their role. */
export const offeredTools = (
  mcpTools: ReadonlyArray<RelayMcpTool>,
  role: string,
): ReadonlySet<string> =>
  new Set(
    mcpTools
      .filter((tool) => AGENT_TOOL_NAMES.has(tool.name) && roleAllows(tool.role, role))
      .map((tool) => tool.name),
  );

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
    /** The agent tools offered to the thread, kept briefly. Never fails: on any error nothing is offered. */
    readonly offered: (threadId: ThreadId) => Effect.Effect<ReadonlySet<string>>;
  }
>()("t3/banneret/agents/AgentRelays/BanneretAgentRelays") {}

export const layer = Layer.effect(
  BanneretAgentRelays,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const projects = yield* ProjectService;
    const enrolment = yield* BanneretEnrolment;
    const feed = yield* BanneretRelayFeed;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof Workspaces.list>>>();

    const forThread = Effect.fn("BanneretAgentRelays.forThread")(function* (threadId: ThreadId) {
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null) return null;
      const project = yield* projects.getShell(thread.projectId);
      if (Option.isNone(project)) return null;
      const { workspaces } = yield* Workspaces.list().pipe(Effect.provideContext(context));
      const relay = enterpriseRelayOf({ workspaces, project: project.value, environmentId });
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

    const lookupOffer = Effect.fn("BanneretAgentRelays.lookupOffer")(
      function* (threadId: ThreadId) {
        const relay = yield* forThread(threadId);
        if (relay === null) return new Set<string>();
        const tools = yield* feed.mcpTools(relay.relayOrigin);
        return tools === null ? new Set<string>() : offeredTools(tools, relay.me.role);
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

    return BanneretAgentRelays.of({
      forThread,
      offered,
    });
  }),
);
