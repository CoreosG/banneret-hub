import { activeRun, answeringAsk, runReceipt, capReached } from "../chat/AnswerTurn.ts";
import { mayPause } from "./pause.ts";
import { makePauseStore, admission } from "../PauseStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { searchKnowledge, knowledgeLabel } from "../memory/KbIndex.ts";
import { personalMessage, sameRule, sentences } from "../memory/corrections.ts";
import * as Schema from "effect/Schema";
import { skillCatalog, describeSkill } from "../skills/catalog.ts";
import { memoryAccess, unavailable } from "../memory/access.ts";
import type { NoteStore } from "../memory/store.ts";
// Banneret Hub: the agent toolkit's handlers. Every call first finds the company the calling thread works for;
// a thread outside one is refused before anything is asked of a relay or a tracker. Lease calls run through
// LeaseService with the same reference the Board builds, so the claim grammar, the settle window, the read-back
// and the account and triage checks are the ones the Take and Release buttons get.
import {
  allBoardCards,
  type SandboxAction,
  type BanneretBoardCard,
  type BanneretFeedState,
  type IssueRef,
  OrchestratorMcpFailure,
  IssueTrackerKind,
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
import { follow, hasHandoff } from "./SandboxHandoff.ts";
import { poolResources, sandboxBooking, BanneretEnrolment, relayHash } from "../relay/Enrolment.ts";
import { BanneretRelayFeed } from "../relay/RelayFeed.ts";
import { type AgentRelay, BanneretAgentRelays } from "./AgentRelays.ts";
import { chatClient, invalid } from "../chat/AgentChat.ts";
import { AgentToolkit } from "./tools.ts";

const maskTokens = (value: string) =>
  value.replace(
    /\b(?:gh[pousr]_|github_pat_|sk-(?:ant-)?|xox[baprs]-|glpat-|AIza)[A-Za-z0-9_-]{16,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[redacted]",
  );

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

const encodeMemory = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const enrolment = yield* BanneretEnrolment;
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
   * The board names the issue directly. Only the relay supplies the person for the lease.
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
    const card = allBoardCards(board.value).find((candidate) => candidate.task.id === taskId);
    const task = card?.task ?? (yield* feed.task(relay.relayOrigin, taskId)).value?.task;
    if (task === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "task_not_found",
        message: `${relay.company}'s board has no task ${taskId}.`,
      });
    }
    return {
      tracker: IssueTrackerKind.make(task.ref.tracker),
      host: task.ref.host ?? "github.com",
      scope: task.ref.scope,
      key: task.ref.key,
      relayOrigin: relay.relayOrigin,
    };
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

  const chat = Effect.gen(function* () {
    const { thread, relay } = yield* requireRelay;
    const device = yield* enrolment.relay(relay.relayOrigin);
    if (!device) return yield* invalid("Join the company to use chat.");
    const status = yield* device.status;
    if (!status.machineId) return yield* invalid("This machine is not enrolled.");
    const known = Option.isNone(providers)
      ? undefined
      : (yield* providers.value.getProviders).find(
          (p) => p.instanceId === thread.providerInstanceId,
        );
    const client = chatClient(
      device,
      thread.threadId,
      providerName(known?.driver ?? "agent"),
      status.machineId,
    );
    yield* client.ensure;
    return client;
  });
  const watchContext = yield* Effect.context<Effect.Services<ReturnType<typeof follow>>>();
  const poolFailure = (error: { message: string }) =>
    new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
  const sandbox = Effect.fn("BanneretAgentTools.sandbox")(function* (
    action: typeof SandboxAction.Type,
  ) {
    const { relay } = yield* requireRelay;
    return yield* sandboxBooking({
      relayOrigin: relay.relayOrigin,
      action,
    }).pipe(Effect.provideService(BanneretEnrolment, enrolment), Effect.mapError(poolFailure));
  });
  const pauseDatabase = yield* Effect.serviceOption(SqlClient.SqlClient);
  const memoryContext = yield* Effect.context<Effect.Services<ReturnType<typeof memoryAccess>>>();
  const accessForCaller = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.thread) return yield* unavailable();
    const thread = scope.thread.threadId;
    const access = yield* memoryAccess(thread, scope.environmentId).pipe(
      Effect.provideContext(memoryContext),
    );
    return { thread, access };
  });
  const memory = Effect.fn("BanneretMemory.invoke")(function* <T>(
    run: (store: NoteStore, thread: ThreadId) => T,
  ) {
    const { access, thread } = yield* accessForCaller;
    const data = yield* access.open((store) => run(store, thread));
    return {
      data: yield* encodeMemory(data).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not encode the note.",
            }),
        ),
      ),
    };
  });
  const catalog = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.thread) return yield* unavailable();
    const thread = scope.thread.threadId;
    const result = yield* skillCatalog(thread, scope.environmentId).pipe(
      Effect.provideContext(memoryContext),
    );
    return { ...result, thread };
  });
  return {
    banneret_skills_list: McpToolAccess.readsAsCaller(() =>
      Effect.map(catalog, ({ skills }) => ({ skills: Array.from(skills.values(), describeSkill) })),
    ),
    banneret_skills_get: McpToolAccess.readsAsCaller(({ name }) =>
      Effect.gen(function* () {
        const { skills, access, thread } = yield* catalog;
        const skill = skills.get(name);
        if (!skill)
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Unknown skill.",
          });
        const key = skill.key;
        if (key) yield* access.open((s) => s.use(key, thread));
        return { ...describeSkill(skill), text: skill.text };
      }),
    ),
    banneret_skills_propose: McpToolAccess.actsAsCaller(({ text, scope, why }) =>
      Effect.gen(function* () {
        const { access } = yield* accessForCaller;
        yield* catalog;
        const key = yield* access.open((s) => String(s.proposeSkill(text, scope, why).key));
        return { key, status: "proposed" as const };
      }),
    ),
    banneret_pause: McpToolAccess.actsAsCaller(() =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (
          !scope.thread ||
          Option.isNone(pauseDatabase) ||
          !(yield* mayPause(scope.thread.threadId, scope.environmentId).pipe(
            Effect.provideContext(memoryContext),
          ))
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only a local orchestrator can pause this machine.",
          });
        const store = yield* makePauseStore.pipe(
          Effect.provideService(SqlClient.SqlClient, pauseDatabase.value),
        );
        yield* admission(store.set(true));
        return { paused: true as const };
      }),
    ),
    banneret_kb_search: McpToolAccess.readsAsCaller(({ query }) =>
      Effect.gen(function* () {
        const { access } = yield* accessForCaller;
        const folders = yield* access.open((s) => s.folders());
        if (!folders.length) return yield* unavailable();
        const hits = yield* Effect.tryPromise({
          try: () => searchKnowledge(folders, query),
          catch: () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not read the configured knowledge folders.",
            }),
        });
        return {
          data:
            knowledgeLabel +
            "\n" +
            (yield* encodeMemory(hits).pipe(Effect.mapError(() => unavailable()))),
        };
      }),
    ),
    banneret_memory_read: McpToolAccess.readsAsCaller(({ key }) => memory((s) => s.read(key))),
    banneret_memory_search: McpToolAccess.readsAsCaller(({ query }) =>
      memory((s) => s.search(query)),
    ),
    banneret_memory_use: McpToolAccess.actsAsCaller(({ key }) =>
      memory((s, thread) => s.use(key, thread)),
    ),
    banneret_memory_propose: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        if (!input.raisedAgain) return yield* memory((s) => s.propose(input));
        const { thread } = yield* accessForCaller;
        const records = yield* (yield* ThreadManagementService)
          .getThreadRecords(thread, ["messages"], { messageRoles: ["user"] })
          .pipe(Effect.mapError(() => unavailable()));
        const evidence = records.messages.filter(personalMessage).flatMap((message) =>
          sentences(message.text)
            .filter((sentence) => sameRule(sentence, input.source))
            .map((sentence) => ({
              thread,
              id: message.id,
              sentence,
              at: DateTime.toEpochMillis(message.createdAt),
            })),
        );
        if (!evidence.some((row) => row.sentence === input.source))
          return yield* invalid("Quote the exact instruction sentence from your person's message.");
        return yield* memory((store) => evidence.map((row) => store.correction(row, input.key)));
      }),
    ),
    banneret_memory_flag: McpToolAccess.actsAsCaller(({ key, reason }) =>
      memory((s, thread) => s.flag(key, reason, thread)),
    ),
    banneret_chat_read: McpToolAccess.readsAsCaller(({ conversation, thread, after, limit }) =>
      Effect.gen(function* () {
        if (!!conversation === !!thread)
          return yield* invalid("Choose one conversation or one thread.");
        return yield* (yield* chat).read(
          thread ? "threads/" + thread : "conversations/" + conversation + "/messages",
          { limit: String(limit ?? 50), ...(after ? { cursor: after } : {}) },
        );
      }),
    ),
    banneret_chat_search: McpToolAccess.readsAsCaller(({ query, limit }) =>
      Effect.gen(function* () {
        return yield* (yield* chat).read("search", { q: query, limit: String(limit ?? 50) });
      }),
    ),
    banneret_chat_post: McpToolAccess.actsAsCaller(({ conversation, text, key, card, task }) =>
      Effect.gen(function* () {
        const result = yield* (yield* chat).write("POST", "messages", {
          conversationId: conversation,
          text,
          key,
          card,
          taskRef: task,
        });
        return { messageId: result.id };
      }),
    ),
    banneret_chat_reply: McpToolAccess.actsAsCaller(({ thread, text, key, card }) =>
      Effect.gen(function* () {
        const client = yield* chat;
        const root = yield* client.root(thread);
        const result = yield* client.write("POST", "messages", {
          conversationId: root.conversationId,
          threadRootId: thread,
          text,
          key,
          card,
        });
        return { messageId: result.id };
      }),
    ),
    banneret_chat_progress: McpToolAccess.actsAsCaller(({ thread, conversation, ...progress }) =>
      Effect.gen(function* () {
        if (!!conversation === !!thread) return yield* invalid("Choose one thread or DM.");
        const result = yield* (yield* chat).write(
          "PUT",
          "messages/" + (thread ?? conversation) + "/progress",
          progress,
        );
        return { messageId: result.id };
      }),
    ),
    banneret_agent_ask: McpToolAccess.actsAsCaller(({ to, thread, ...ask }) =>
      Effect.gen(function* () {
        const client = yield* chat;
        const threads = yield* ThreadManagementService;
        const run = yield* activeRun(threads, (yield* requireRelay).thread.threadId).pipe(
          Effect.mapError(() => invalid("Cannot identify the asking turn.")),
        );
        const parentAskId = run && answeringAsk(run.userMessageId);
        if (run?.userMessageId.startsWith("chat-dm:")) {
          const message = (yield* threads
            .getMessagesById(run.threadId, [run.userMessageId])
            .pipe(Effect.mapError(() => invalid("Cannot identify the original DM.")))).get(
            run.userMessageId,
          );
          yield* client.checkDmHome(
            thread,
            message?.createdBy === "user"
              ? message.text.split("\n---\n").slice(1).join("\n---\n")
              : "",
          );
        }
        const target = yield* client.resolveHandle(to);
        const receipt =
          run &&
          (yield* runReceipt(threads, run, client.asHandle).pipe(
            Effect.mapError(() => invalid("Cannot read this turn's usage.")),
          ));
        const result = yield* client.write("POST", "asks", {
          ...ask,
          to: { kind: "agent", handle: target },
          threadRootId: thread,
          parentAskId,
          receipt,
        });
        return { askId: result.id };
      }),
    ),
    banneret_agent_answer: McpToolAccess.actsAsCaller(({ text, choice }) =>
      Effect.gen(function* () {
        const client = yield* chat;
        const threads = yield* ThreadManagementService;
        const run = yield* activeRun(threads, (yield* requireRelay).thread.threadId).pipe(
          Effect.mapError(() => invalid("Cannot identify the answering turn.")),
        );
        const askId = run && answeringAsk(run.userMessageId);
        if (!run || !askId)
          return yield* invalid("Only the turn answering this question can post an answer.");
        const receipt = yield* runReceipt(threads, run, client.asHandle).pipe(
          Effect.mapError(() => invalid("Cannot read this turn's usage.")),
        );
        const reason = capReached(receipt, yield* client.policy);
        const result = yield* client.write(
          "POST",
          "asks/" + askId + "/answer",
          reason
            ? { none: true, reason, receipt }
            : { text: maskTokens(text), choice: choice && maskTokens(choice), receipt },
        );
        if (reason) return yield* invalid("The answer reached its usage limit.");
        return { askId: result.id };
      }),
    ),
    banneret_chat_ask: McpToolAccess.actsAsCaller(({ thread, task, ...ask }) =>
      Effect.gen(function* () {
        const result = yield* (yield* chat).write("POST", "asks", {
          ...ask,
          to: { kind: "person", person: ask.to },
          threadRootId: thread,
          taskRef: task,
        });
        return { askId: result.id };
      }),
    ),
    banneret_chat_inbox: McpToolAccess.actsAsCaller(() =>
      Effect.gen(function* () {
        return yield* (yield* chat).consumeInbox;
      }),
    ),
    banneret_pool_status: McpToolAccess.readsAsCaller(() =>
      Effect.gen(function* () {
        const { relay } = yield* requireRelay;
        return yield* poolResources({
          relayOrigin: relay.relayOrigin,
        }).pipe(Effect.provideService(BanneretEnrolment, enrolment), Effect.mapError(poolFailure));
      }),
    ),
    banneret_sandbox_status: McpToolAccess.readsAsCaller(({ id }) => sandbox({ kind: "read", id })),
    banneret_sandbox_request: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { thread, relay } = yield* requireRelay;
        const receipt = yield* sandbox({ kind: "launch", ...input });
        if (input.taskId)
          yield* follow({
            relayOrigin: relay.relayOrigin,
            login: relay.me.login,
            threadId: thread.threadId,
            taskId: input.taskId,
            id: receipt.id,
          }).pipe(
            Effect.provideContext(watchContext),
            Effect.tapError(() => sandbox({ kind: "cancel", id: receipt.id })),
            Effect.mapError(poolFailure),
          );
        return receipt;
      }),
    ),
    banneret_sandbox_cancel: McpToolAccess.actsAsCaller(({ id }) =>
      Effect.gen(function* () {
        const booking = yield* sandbox({ kind: "read", id });
        if (booking.taskId && booking.state === "running") {
          const { relay } = yield* requireRelay;
          const current = yield* leases.check(yield* leaseRef(relay, booking.taskId));
          if (current.sandboxAgent === "sandbox-" + relayHash(id))
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "Save the hand-off note and release this sandbox claim with handing_over and freeToContinue true before cancelling.",
            });
        }
        return yield* sandbox({ kind: "cancel", id });
      }),
    ),
    banneret_board: McpToolAccess.readsAsCaller(({ board: boardId, column, mine, repo, limit }) =>
      Effect.gen(function* () {
        const { relay } = yield* requireRelay;
        const board = (yield* feedState(relay))?.board ?? null;
        if (board === null) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: `${relay.company}'s relay does not offer a board.`,
          });
        }
        const entries = board.value?.boards ?? [];
        const picked =
          boardId === undefined ? entries : entries.filter((entry) => entry.id === boardId);
        if (boardId !== undefined && picked.length === 0) {
          const known = entries.map((entry) => entry.id).join(", ");
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `${relay.company} has no board ${boardId}. Boards: ${known === "" ? "none yet" : known}.`,
          });
        }
        const me = relay.me.login;
        // A task id is relay-wide: a task two boards show is listed once, on its first board.
        const seen = new Set<string>();
        const onBoards = picked.flatMap((entry) =>
          (entry.board?.cards ?? []).flatMap((card) => {
            if (seen.has(card.task.id)) return [];
            seen.add(card.task.id);
            return [{ boardId: entry.id, card }];
          }),
        );
        const cards = onBoards.filter(
          ({ card }) =>
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
          boards: entries.map((entry) => ({
            id: entry.id,
            title: entry.title,
            mode: entry.mode,
            counts: entry.counts,
          })),
          total: cards.length,
          cards: cards
            .slice(0, limit ?? DEFAULT_BOARD_LIMIT)
            .map(({ boardId: id, card }) => ({ board: id, ...cardView(card) })),
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
    banneret_team: McpToolAccess.readsAsCaller(({ person }) =>
      Effect.gen(function* () {
        const { relay } = yield* requireRelay;
        const state = yield* feedState(relay);
        const team = state?.team ?? null;
        if (team === null) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: `${relay.company}'s relay does not offer a team view.`,
          });
        }
        // Titles and leases come from the boards and the map the Hub already holds.
        const cards = allBoardCards(state?.board?.value);
        const titles = new Map<string, string>(
          cards.map((card) => [card.task.id, card.task.title]),
        );
        for (const item of state?.map?.value?.items ?? []) {
          if (item.task !== undefined && !titles.has(item.task.id)) {
            titles.set(item.task.id, item.task.title);
          }
        }
        const people = (team.value?.people ?? []).filter(
          (entry) => person === undefined || same(entry.login, person),
        );
        const sessions = new Map<string, (typeof people)[number]["sessions"][number][]>();
        if (team.value?.office && people.length) {
          const wanted = new Set(people.map((p) => p.id));
          const keys = [null, ...team.value.office.summary.rooms.map((r) => r.board)];
          for (const board of keys) {
            let cursor: string | undefined;
            const seen = new Set<string>();
            do {
              const page = yield* feed.room(relay.relayOrigin, board, cursor);
              if (!page || (page.nextCursor && seen.has(page.nextCursor)))
                return yield* new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "Could not read Team sessions.",
                });
              for (const session of page.sessions) {
                if (!wanted.has(session.personId)) continue;
                const rows = sessions.get(session.personId) ?? [];
                rows.push(session);
                sessions.set(session.personId, rows);
              }
              cursor = page.nextCursor ?? undefined;
              if (cursor) seen.add(cursor);
            } while (cursor);
          }
        }
        return {
          ...companyOf(relay),
          fetchedAt: team.fetchedAt,
          ...problemOf(team),
          people: people.map((entry) => {
            const labels = new Map(entry.machines.map((machine) => [machine.id, machine.label]));
            return {
              login: entry.login,
              role: entry.role.name,
              machines: entry.machines.map((machine) => ({
                label: machine.label,
                online: machine.connected,
              })),
              leases: cards.flatMap((card) =>
                card.lease !== undefined && same(card.lease.holder.login, entry.login)
                  ? [{ taskId: card.task.id, title: card.task.title, state: card.lease.state }]
                  : [],
              ),
              sessions: (sessions.get(entry.id) ?? entry.sessions).map((session) => {
                const title = session.taskId === undefined ? undefined : titles.get(session.taskId);
                return {
                  id: session.id,
                  ...(session.parentId === undefined ? {} : { parentId: session.parentId }),
                  machine: session.machineId
                    ? (labels.get(session.machineId) ?? session.machineId)
                    : "private",
                  provider: session.provider,
                  state: session.state,
                  ...(session.waiting === undefined ? {} : { waiting: session.waiting }),
                  ...(session.taskId === undefined ? {} : { taskId: session.taskId }),
                  ...(title === undefined ? {} : { taskTitle: title }),
                  since: session.since,
                };
              }),
            };
          }),
        };
      }),
    ),
    banneret_lease_check: McpToolAccess.readsAsCaller(({ taskId }) =>
      Effect.gen(function* () {
        const { relay } = yield* requireRelay;
        return yield* leases.check(yield* leaseRef(relay, taskId));
      }),
    ),
    banneret_lease_take: McpToolAccess.actsAsCaller(({ taskId, sandboxId }) =>
      Effect.gen(function* () {
        const { thread, relay } = yield* requireRelay;
        if (
          !sandboxId &&
          (yield* hasHandoff(relay.relayOrigin, relay.me.login, taskId).pipe(
            Effect.provideContext(watchContext),
            Effect.mapError(poolFailure),
          ))
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This task has a sandbox booking. Claim it on the running sandbox Hub with its sandboxId.",
          });
        if (sandboxId !== undefined) {
          const booking = yield* sandbox({ kind: "read", id: sandboxId });
          const here = yield* enrolment.status(relay.relayOrigin);
          if (
            booking.taskId !== taskId ||
            booking.state !== "running" ||
            !booking.machineId ||
            here.machineId !== booking.machineId
          )
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Claim from the running sandbox Hub for this task.",
            });
        }
        const { relayOrigin, ...ref } = yield* leaseRef(relay, taskId);
        const result = yield* leases.take({
          ...ref,
          relayOrigin,
          agent: sandboxId ? "sandbox-" + relayHash(sandboxId) : yield* agentFor(thread),
        });
        if (result.outcome === "taken")
          yield* linkThread(thread.threadId, { ...ref, projectId: relay.projectId });
        return result;
      }),
    ),
    banneret_lease_release: McpToolAccess.actsAsCaller(
      ({ taskId, sandboxId, reason, reasonText, note, freeToContinue, followUps }) =>
        Effect.gen(function* () {
          const { relay } = yield* requireRelay;
          const ref = yield* leaseRef(relay, taskId);
          // LeaseService releases only a lease the tracker login holds, and that login must be the relay's
          // person: an agent never releases someone else's lease.
          if (
            sandboxId !== undefined &&
            (!note?.trim() ||
              (reason !== "out_of_usage" && reason !== "handing_over") ||
              freeToContinue === false)
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "Save the hand-off note, choose handing_over or out_of_usage and leave the task free to continue.",
            });
          const released = yield* leases.release(
            {
              ...ref,
              reason,
              reasonText,
              note,
              freeToContinue: freeToContinue ?? FREE_TO_CONTINUE_BY_DEFAULT.has(reason),
              followUps,
            },
            sandboxId ? "sandbox-" + relayHash(sandboxId) : undefined,
          );
          if (released.outcome === "released")
            yield* memory((store, thread) => store.nudge(thread)).pipe(Effect.ignoreCause);
          return released;
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
