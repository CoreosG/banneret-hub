// Banneret Hub: the agent toolkit's handlers. Every call first finds the company the calling thread works for;
// a thread outside one is refused before anything is asked of a relay or a tracker. Lease calls run through
// LeaseService with the same reference the Board builds, so the claim grammar, the settle window, the read-back
// and the account and triage checks are the ones the Take and Release buttons get.
import {
  type BanneretBoardCard,
  type BanneretFeedState,
  type IssueRef,
  OrchestratorMcpFailure,
  type TaskLeaseRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as IssueService from "../../issue/IssueService.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ThreadIssueService from "../../orchestration-v2/ThreadIssueService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { LeaseService } from "../lease/LeaseService.ts";
import { BanneretRelayFeed } from "../relay/RelayFeed.ts";
import { type AgentRelay, BanneretAgentRelays } from "./AgentRelays.ts";
import { AgentToolkit } from "./tools.ts";

const DEFAULT_BOARD_LIMIT = 50;
/** The release reasons that leave a task free to continue unless the agent says otherwise, as in the dialog. */
const FREE_TO_CONTINUE_BY_DEFAULT = new Set(["blocked", "handing_over", "out_of_usage"]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const notInCompany = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "This thread's project is not in an Enterprise workspace this machine has joined, so it has no company board or leases.",
});

/**
 * The claim's `<agent>`: the provider and the start of the thread id, such as `claude-1a2b3c4d`. Never the
 * thread title, which stays on the machine.
 */
const agentLabel = (provider: string, threadId: string): string => {
  const slug = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 32);
  const label = [
    slug(provider) || "agent",
    slug(threadId.replace(/^thread[:_-]?/i, "")).slice(0, 8),
  ]
    .filter((part) => part !== "")
    .join("-");
  return label.slice(0, 64);
};

const providerName = (driver: string) =>
  driver === "claudeAgent" ? "claude" : driver === "codex" ? "codex" : driver;

const cardView = (card: BanneretBoardCard) => ({
  id: card.task.id,
  title: card.task.title,
  url: card.task.ref.url,
  repo: card.task.ref.scope,
  column: card.column,
  status: card.status,
  statusWhy: card.statusWhy,
  ...(card.lease === undefined
    ? {}
    : { holder: card.lease.holder.login, leaseState: card.lease.state }),
  assignees: card.assignees.map((person) => person.login),
  ...(card.lastRelease === undefined
    ? {}
    : {
        lastRelease: {
          by: card.lastRelease.by.login,
          at: card.lastRelease.at,
          reason: card.lastRelease.reason,
          freeToContinue: card.lastRelease.freeToContinue,
          ...(card.lastRelease.reasonText === undefined
            ? {}
            : { reasonText: card.lastRelease.reasonText }),
          ...(card.lastRelease.note === undefined ? {} : { note: card.lastRelease.note }),
        },
      }),
  prs: card.prs.map((pr) => ({
    number: pr.number,
    url: pr.url,
    state: pr.state,
    ...(pr.checks === undefined ? {} : { checks: pr.checks.state }),
  })),
  restsOn: card.restsOn,
});

const problemOf = (read: { readonly problem?: { readonly message: string } | undefined }) =>
  read.problem === undefined ? {} : { problem: read.problem.message };

const make = Effect.gen(function* () {
  const relays = yield* BanneretAgentRelays;
  const feed = yield* BanneretRelayFeed;
  const leases = yield* LeaseService;
  const issues = yield* IssueService.IssueService;
  const threadIssues = yield* ThreadIssueService.ThreadIssueService;
  const providers = yield* Effect.serviceOption(ProviderRegistry);

  const callerThread = Effect.map(
    McpInvocationContext.McpInvocationContext,
    (scope) => scope.thread,
  );

  /** The company the calling thread works for, read now. */
  const requireRelay = Effect.gen(function* () {
    const thread = yield* callerThread;
    const relay = thread === undefined ? null : yield* relays.forThread(thread.threadId);
    if (thread === undefined || relay === null) return yield* notInCompany;
    return { thread, relay };
  });

  /** The relay's current feed state, from memory: the board and its flags as last read. */
  const feedState = (relay: AgentRelay) =>
    Stream.runHead(feed.events(relay.relayOrigin)).pipe(
      Effect.map(Option.getOrUndefined<BanneretFeedState>),
    );

  const companyOf = (relay: AgentRelay) => ({ company: relay.company, me: relay.me.login });

  const agentFor = Effect.fn("BanneretAgentTools.agentFor")(function* (thread: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: string;
  }) {
    const known = Option.isNone(providers)
      ? undefined
      : (yield* providers.value.getProviders).find(
          (provider) => provider.instanceId === thread.providerInstanceId,
        );
    return agentLabel(providerName(known?.driver ?? "agent"), thread.threadId);
  });

  /**
   * The lease reference for a board task: its issue, resolved through this machine's own project on that
   * repository (preferring the thread's), and the relay whose person acts.
   */
  const leaseRef = Effect.fn("BanneretAgentTools.leaseRef")(function* (
    relay: AgentRelay,
    taskId: string,
  ) {
    const board = (yield* feedState(relay))?.board ?? null;
    if (board === null) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: `${relay.company}'s relay does not offer a board, so tasks cannot be taken here.`,
      });
    }
    if (!board.leases) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: `${relay.company}'s relay does not read leases, so take and release are off.`,
      });
    }
    const card = board.value?.cards.find((candidate) => candidate.task.id === taskId);
    const url =
      card?.task.ref.url ?? (yield* feed.task(relay.relayOrigin, taskId)).value?.task.ref.url;
    if (url === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "task_not_found",
        message: `${relay.company}'s board has no task ${taskId}.`,
      });
    }
    const resolved = yield* issues.resolveUrl(url, relay.projectId).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `No project on this machine can reach ${url}: ${error.message}`,
          }),
      ),
    );
    const ref: IssueRef & { readonly host: string } = {
      projectId: resolved.projectId,
      tracker: resolved.tracker,
      host: resolved.host,
      scope: resolved.scope,
      key: resolved.key,
    };
    return { ...ref, relayOrigin: relay.relayOrigin } satisfies TaskLeaseRef;
  });

  /**
   * Links the thread to the task's issue after a take, so its heartbeat names the task and keeps the lease
   * fresh while the agent works. Best effort: a take that succeeded never fails for it.
   */
  const linkThread = Effect.fn("BanneretAgentTools.linkThread")(
    function* (threadId: ThreadId, ref: IssueRef & { readonly host: string }) {
      const issue = yield* issues.linkMetadata(ref);
      yield* threadIssues.link({
        threadId,
        ref,
        url: issue.url,
        displayKey: issue.displayKey,
        title: issue.title,
        source: "agent",
      });
    },
    (effect) => Effect.ignoreCause(effect),
  );

  return {
    banneret_board: McpToolAccess.readsAsCaller(({ column, mine, repo, limit }) =>
      Effect.gen(function* () {
        const { relay } = yield* requireRelay;
        const board = (yield* feedState(relay))?.board ?? null;
        if (board === null) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: `${relay.company}'s relay does not offer a board.`,
          });
        }
        const me = relay.me.login;
        const cards = (board.value?.cards ?? []).filter(
          (card) =>
            (column === undefined || same(card.column, column)) &&
            (repo === undefined || same(card.task.ref.scope, repo)) &&
            (mine !== true ||
              (card.lease !== undefined && same(card.lease.holder.login, me)) ||
              card.assignees.some((person) => same(person.login, me))),
        );
        return {
          ...companyOf(relay),
          fetchedAt: board.fetchedAt,
          ...problemOf(board),
          leases: board.leases,
          total: cards.length,
          cards: cards.slice(0, limit ?? DEFAULT_BOARD_LIMIT).map(cardView),
        };
      }),
    ),
    banneret_needs: McpToolAccess.readsAsCaller(({ cursor }) =>
      Effect.gen(function* () {
        const { relay } = yield* requireRelay;
        const read = yield* feed.needs(relay.relayOrigin, cursor);
        return {
          ...companyOf(relay),
          fetchedAt: read.fetchedAt,
          ...problemOf(read),
          items: (read.value?.items ?? []).map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            ...(item.recommendation === undefined ? {} : { recommendation: item.recommendation }),
            ...(item.from === undefined ? {} : { from: item.from.login }),
            ...(item.url === undefined ? {} : { url: item.url }),
            createdAt: item.createdAt,
          })),
          nextCursor: read.value?.nextCursor ?? null,
        };
      }),
    ),
    banneret_task: McpToolAccess.readsAsCaller(({ taskId }) =>
      Effect.gen(function* () {
        const { relay } = yield* requireRelay;
        const read = yield* feed.task(relay.relayOrigin, taskId);
        if (read.value === null) {
          return yield* new OrchestratorMcpFailure({
            code: "task_not_found",
            message:
              read.notFound === true
                ? `${relay.company}'s relay has no task ${taskId}.`
                : (read.problem?.message ?? `${relay.company}'s relay did not answer.`),
          });
        }
        const task = read.value;
        return {
          ...companyOf(relay),
          fetchedAt: read.fetchedAt,
          ...problemOf(read),
          task: {
            ...cardView(task),
            ...(task.preview === undefined ? {} : { preview: task.preview }),
            ...(task.checked === undefined || !task.checked.valid
              ? {}
              : { checkedBy: task.checked.by.login }),
          },
        };
      }),
    ),
    banneret_lease_check: McpToolAccess.readsAsCaller(({ taskId }) =>
      Effect.gen(function* () {
        const { relay } = yield* requireRelay;
        return yield* leases.check(yield* leaseRef(relay, taskId));
      }),
    ),
    banneret_lease_take: McpToolAccess.actsAsCaller(({ taskId }) =>
      Effect.gen(function* () {
        const { thread, relay } = yield* requireRelay;
        const { relayOrigin, ...ref } = yield* leaseRef(relay, taskId);
        const result = yield* leases.take({ ...ref, relayOrigin, agent: yield* agentFor(thread) });
        if (result.outcome === "taken") yield* linkThread(thread.threadId, ref);
        return result;
      }),
    ),
    banneret_lease_release: McpToolAccess.actsAsCaller(
      ({ taskId, reason, reasonText, note, freeToContinue, followUps }) =>
        Effect.gen(function* () {
          const { relay } = yield* requireRelay;
          const ref = yield* leaseRef(relay, taskId);
          // LeaseService releases only a lease the tracker login holds, and that login must be the relay's
          // person: an agent never releases someone else's lease.
          return yield* leases.release({
            ...ref,
            reason,
            reasonText,
            note,
            freeToContinue: freeToContinue ?? FREE_TO_CONTINUE_BY_DEFAULT.has(reason),
            followUps,
          });
        }),
    ),
    banneret_lease_withdraw: McpToolAccess.actsAsCaller(({ taskId }) =>
      Effect.gen(function* () {
        const { relay } = yield* requireRelay;
        return yield* leases.withdraw(yield* leaseRef(relay, taskId));
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof AgentToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(AgentToolkit, make);
