// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalJsonInEffect:off globalDate:off - a local company tracker.
// Take, Release and thread linking against a company's task source, with a fake tracker that behaves as the
// plugin template's does (its task ids are its own) and remembers idempotency keys.
import * as NodeHttp from "node:http";

import { describe, expect, it } from "@effect/vitest";
import {
  TASK_LEASE_WS_METHODS,
  threadIssueKeysEqual,
  ThreadId,
  type BanneretFeedState,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpServer } from "effect/ai";

import { ServerConfig } from "../../config.ts";
import { idleThreadProjection } from "../../mcp/McpToolAccess.testkit.ts";
import { ThreadIssueService } from "../../orchestration-v2/ThreadIssueService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import { rpcHandlers, LeaseService, type LeaseServiceShape } from "../lease/LeaseService.ts";
import { approvalMachine } from "../plugins/approvals.ts";
import { relayHash } from "../relay/Enrolment.ts";
import { BanneretRelayFeed } from "../relay/RelayFeed.ts";
import { taskIdForLinks } from "../relay/Snapshot.ts";
import { environmentId, external, inThread, makeHub, ORIGIN, shellOf } from "./company.testkit.ts";
import * as ProviderLeases from "./providerLeases.ts";
import { SOURCE_TIMEOUTS } from "./sourceClient.ts";
import { linkFor, transition } from "./taskLink.ts";
import { applyCredential } from "./tokens.ts";

const refOf = (key: string, tracker = "acme_jira") => ({
  tracker,
  scope: "PLAT",
  key,
  url: `https://jira.example.test/browse/${key}`,
});
const cardOf = (id: string, key: string) => ({
  task: {
    id,
    title: `Task ${key}`,
    ref: refOf(key),
    openedAt: "2026-11-20T09:00:00Z",
    closedAt: null,
  },
  kind: "task",
  column: "ready",
  status: "open",
  statusWhy: "Open.",
  assignees: [],
  prs: [],
  restsOn: [],
});
type Card = ReturnType<typeof cardOf> & { lease?: object; lastRelease?: object };

interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly authorization: string | undefined;
}

/** The company tracker. `silent` writes are applied and then never answered. */
const tracker = Effect.gen(function* () {
  const state = {
    cards: [cardOf("T1", "PLAT-1"), cardOf("T2", "PLAT-2")] as Card[],
    calls: [] as ToolCall[],
    claimsApplied: 0,
    silent: 0,
    readOnlyClaim: false,
    offers: ["tasks_list_boards", "tasks_list_tasks", "tasks_read", "tasks_claim", "tasks_release"],
    answers: new Map<string, object>(),
  };
  const holder = (card: Card) => (card.lease as { holder: { login: string } } | undefined)?.holder;
  const run = (name: string, args: Record<string, unknown>, actor: string): object => {
    if (name === "tasks_list_boards") return { boards: [{ id: "PLAT", title: "Platform" }] };
    if (name === "tasks_list_tasks") return { tasks: state.cards };
    const card = state.cards.find((one) => one.task.id === args.taskId);
    if (!card) throw new Error("Unknown task");
    if (name === "tasks_read") return card;
    const known = state.answers.get(String(args.idempotencyKey));
    if (known) return known;
    let answer: object;
    if (name === "tasks_claim") {
      if (holder(card)) answer = { status: holder(card)!.login === actor ? "claimed" : "conflict" };
      else {
        card.lease = { holder: { id: actor, login: actor }, state: "active" };
        state.claimsApplied += 1;
        answer = { status: "claimed" };
      }
    } else if (holder(card)?.login !== actor) answer = { status: "not_holder" };
    else {
      delete card.lease;
      card.lastRelease = {
        by: { id: actor, login: actor },
        at: "2026-11-20T10:00:00Z",
        reason: args.reason,
        freeToContinue: args.freeToContinue,
        ...(args.note ? { note: args.note } : {}),
      };
      answer = { status: "released" };
    }
    if (typeof args.idempotencyKey === "string") state.answers.set(args.idempotencyKey, answer);
    return answer;
  };
  const server = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const server = NodeHttp.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const authorization = request.headers.authorization;
        if (rpc.id === undefined) return void response.writeHead(202).end();
        let result: object;
        if (rpc.method === "tools/list")
          result = {
            tools: state.offers.map((name) => ({
              name: "acme_" + name,
              ...(state.readOnlyClaim && name === "tasks_claim"
                ? { annotations: { readOnlyHint: true } }
                : {}),
            })),
          };
        else if (rpc.method === "tools/call") {
          const name = String(rpc.params.name).replace(/^acme_/, "");
          state.calls.push({ name, args: rpc.params.arguments, authorization });
          try {
            const structuredContent = run(
              name,
              rpc.params.arguments,
              authorization === "Bearer bob-token" ? "bob" : "alice",
            );
            if (state.silent > 0 && (name === "tasks_claim" || name === "tasks_release")) {
              state.silent -= 1;
              return;
            }
            result = { content: [{ type: "text", text: "done" }], structuredContent };
          } catch (error) {
            result = { content: [{ type: "text", text: (error as Error).message }], isError: true };
          }
        } else
          result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "a" } };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server;
    }),
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );
  const address = server.address() as { port: number };
  return {
    state,
    url: `http://127.0.0.1:${address.port}/mcp`,
    writes: () => state.calls.filter((c) => /tasks_(claim|release)/.test(c.name)),
    holder: (id: string) => holder(state.cards.find((c) => c.task.id === id)!)?.login,
  };
});

const hub = makeHub(McpServer.McpServer);

/** The thread's saved issue links, which are the whole of the linking state. */
const threadLinks = (threadId: ThreadId, links: ThreadIssueLink[]) => ({
  shell: () => Effect.sync(() => ({ ...shellOf(threadId), issues: [...links] })),
  issues: ThreadIssueService.of({
    link: ({ ref, ...input }) =>
      Effect.sync(() => {
        const { projectId, tracker, host, scope, key } = ref;
        links.push({
          tracker,
          host,
          scope,
          key,
          projectId: projectId!,
          url: input.url,
          displayKey: input.displayKey,
          title: input.title,
          source: input.source,
          linkedAt: "2026-11-20T10:00:00.000Z",
        });
        return { alreadyLinked: false };
      }),
    unlink: ({ key }) =>
      Effect.sync(() => {
        const index = links.findIndex((link) => threadIssueKeysEqual(link, key));
        if (index >= 0) links.splice(index, 1);
        return { wasLinked: index >= 0 };
      }),
    linkedThreads: () => Effect.succeed({ threads: [] }),
  }),
});

/**
 * A relay board whose ids are the relay's own (`r1`, `r2`): the source's ids are `T1`, `T2`. `PLAT-9`
 * is on the board but not shown to this person by the source.
 */
const relayCards = [cardOf("r1", "PLAT-1"), cardOf("r2", "PLAT-2"), cardOf("r9", "PLAT-9")];
const feed = {
  ...BanneretRelayFeed.defaultValue(),
  events: () =>
    Stream.make({
      board: {
        value: { boards: [{ board: { cards: relayCards } }] },
      },
    } as unknown as BanneretFeedState),
};

const neverGitHub = new Proxy({} as LeaseServiceShape, {
  get: () => () => Effect.die("A company's task reached Banneret's GitHub leases."),
});
/** Only Banneret's own take hands a task to an orchestrator chat, so a company's must use none. */
const noHandoff = Layer.mergeAll(
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(ServerSettingsService)({}),
  Layer.mock(ThreadLaunchService)({}),
);

const setUp = (name: string, links: ThreadIssueLink[] = []) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(name);
    const company = yield* tracker;
    const thread = threadLinks(threadId, links);
    const t = yield* hub({ threadId, url: company.url, auth: "bearer_per_person" }).pipe(
      Effect.provideService(ThreadIssueService, thread.issues),
      Effect.provideService(ThreadManagementService, {
        getThreadShell: thread.shell,
        getThreadRecords: () => Effect.sync(() => idleThreadProjection(shellOf(threadId))),
      } as unknown as ThreadManagementService["Service"]),
    );
    const signIn = (token: string) =>
      applyCredential(ORIGIN, "acme-gw", {
        type: "signed_in",
        credential: { url: company.url, status: "signed_in", kind: "bearer", token },
      });
    yield* signIn("alice-token");
    yield* t.publish({ tasks: external("acme-gw") });
    return { threadId, company, t, links, signIn };
  });

const input = (taskId: string) => ({
  // Everything but the board id is the client's to invent. The server must not route on it.
  tracker: "external" as never,
  scope: "-",
  key: "-",
  relayOrigin: ORIGIN,
  taskId,
});
const releaseOf = (taskId: string) => ({
  ...input(taskId),
  reason: "handing_over" as const,
  freeToContinue: true,
  note: "Next: review.",
});

const rpc = {
  check: (taskId: string) => rpcHandlers[TASK_LEASE_WS_METHODS.check](input(taskId)),
  take: (taskId: string) => rpcHandlers[TASK_LEASE_WS_METHODS.take](input(taskId)),
  release: (taskId: string) => rpcHandlers[TASK_LEASE_WS_METHODS.release](releaseOf(taskId)),
  finish: (taskId: string) => rpcHandlers[TASK_LEASE_WS_METHODS.finish](input(taskId)),
  withdraw: (taskId: string) => rpcHandlers[TASK_LEASE_WS_METHODS.withdraw](input(taskId)),
};

const run = <A, E, R>(name: string, body: Effect.Effect<A, E, R>) =>
  inThread(
    ThreadId.make(name),
    body.pipe(
      Effect.provideService(BanneretRelayFeed, feed),
      Effect.provideService(LeaseService, neverGitHub),
      Effect.provide(noHandoff),
    ),
  );

describe("take and release against a company's tracker", () => {
  it.live("takes and releases with the person's own sign-in, never through Banneret's leases", () =>
    run(
      "provider-take",
      Effect.gen(function* () {
        const { company } = yield* setUp("provider-take");
        const before = yield* rpc.check("r1");
        expect(before).toMatchObject({
          availability: "available",
          viewer: null,
          lease: null,
          actions: { take: true, release: false, finish: false, withdraw: false },
        });

        const taken = yield* rpc.take("r1");
        expect(taken).toMatchObject({
          outcome: "taken",
          status: { lease: { holder: "alice" }, actions: { take: false, release: true } },
        });
        const claim = company.writes()[0]!;
        // The relay's id is not the source's: the claim names the source's own.
        expect(claim.args.taskId).toBe("T1");
        expect(claim.args.idempotencyKey).toEqual(expect.any(String));
        expect(company.state.calls.every((c) => c.authorization === "Bearer alice-token")).toBe(
          true,
        );

        const released = yield* rpc.release("r1");
        expect(released).toMatchObject({
          outcome: "released",
          status: { lease: null, lastRelease: { by: "alice", note: "Next: review." } },
        });
        expect(company.writes()[1]!.args).toMatchObject({
          taskId: "T1",
          reason: "handing_over",
          freeToContinue: true,
        });
        expect(company.writes()[1]!.args.idempotencyKey).not.toBe(claim.args.idempotencyKey);

        expect(yield* Effect.flip(rpc.finish("r1"))).toMatchObject({
          detail: "Acme gateway owns claims here. There is nothing to finish or withdraw.",
        });
        expect((yield* Effect.flip(rpc.withdraw("r1"))).reason).toBe("unavailable");
      }),
    ),
  );

  it.live("leaves the source to say who holds a task, and names it in every refusal", () =>
    run(
      "provider-holder",
      Effect.gen(function* () {
        const { company, signIn } = yield* setUp("provider-holder");
        yield* rpc.take("r1");
        yield* signIn("bob-token");
        expect(yield* rpc.take("r1")).toMatchObject({
          outcome: "lost",
          detail: "Acme gateway says alice holds this task.",
        });
        expect(yield* Effect.flip(rpc.release("r1"))).toMatchObject({
          reason: "refused",
          detail: "Acme gateway says you do not hold this task.",
        });
        expect(company.holder("T1")).toBe("alice");
      }),
    ),
  );

  it.live("writes nothing for a task the source does not show the person", () =>
    run(
      "provider-hidden",
      Effect.gen(function* () {
        const { company } = yield* setUp("provider-hidden");
        expect(yield* rpc.check("r9")).toMatchObject({
          availability: "no-permission",
          detail: "Acme gateway does not show you this task, so take and release are off.",
          actions: { take: false, release: false },
        });
        expect((yield* Effect.flip(rpc.take("r9"))).message).toContain("does not show you");
        // A task that is not on this person's board is not looked for at the source at all.
        expect((yield* Effect.flip(rpc.take("somebody-elses"))).message).toBe(
          "This task from Acme gateway is not on your board here.",
        );
        // The source's id under another reference is not the board's task.
        company.state.cards[0]!.task.ref.url = "https://jira.example.test/browse/OTHER";
        expect((yield* Effect.flip(rpc.take("r1"))).message).toContain("does not show you");
        expect(company.writes()).toEqual([]);
      }),
    ),
  );

  it.live("says why take and release are off, naming the source", () =>
    run(
      "provider-off",
      Effect.gen(function* () {
        const { company, t, signIn } = yield* setUp("provider-off");
        company.state.offers = company.state.offers.filter((name) => name !== "tasks_release");
        expect(yield* rpc.check("r1")).toMatchObject({
          availability: "unsupported",
          detail: "Acme gateway is unavailable. It does not offer acme_tasks_release.",
        });
        yield* applyCredential(ORIGIN, "acme-gw", { type: "signed_out" });
        expect(yield* rpc.check("r1")).toMatchObject({
          availability: "signed-out",
          detail: "Sign in to Acme gateway on this machine, under Settings, Chat, Company servers.",
        });
        expect((yield* Effect.flip(rpc.take("r1"))).message).toContain("Sign in to Acme gateway");
        expect(company.writes()).toEqual([]);
        yield* signIn("alice-token");

        // A relay that does not leave claims to the source gets no claim from the Hub.
        yield* t.publish({
          tasks: {
            owner: "external",
            source: "acme-gw",
            title: "Acme gateway",
            prefix: "acme_",
            leases: "unsupported",
          },
        });
        expect((yield* Effect.flip(rpc.take("r1"))).message).toContain(
          "the relay does not leave claims to it",
        );
        yield* t.publish({ tasks: { owner: "off" } });
        expect((yield* Effect.flip(rpc.take("r1"))).message).toBe(
          "Tasks are turned off at this company.",
        );
        expect(company.writes()).toEqual([]);
      }),
    ),
  );

  it.live("retries a silent claim with the same key, so it never claims twice", () =>
    run(
      "provider-retry",
      Effect.gen(function* () {
        const { company } = yield* setUp("provider-retry");
        const limit = SOURCE_TIMEOUTS.exchangeMs;
        yield* Effect.acquireRelease(
          Effect.sync(() => (SOURCE_TIMEOUTS.exchangeMs = 300)),
          () => Effect.sync(() => (SOURCE_TIMEOUTS.exchangeMs = limit)),
        );
        company.state.silent = 1;
        expect((yield* rpc.take("r1")).outcome).toBe("taken");
        expect(company.writes()).toHaveLength(2);
        expect(company.writes()[1]!.args.idempotencyKey).toBe(
          company.writes()[0]!.args.idempotencyKey,
        );
        expect(company.state.claimsApplied).toBe(1);

        // Silent twice: the Hub says so, and the same press later still carries the same key.
        company.state.silent = 2;
        expect((yield* Effect.flip(rpc.take("r2"))).message).toBe(
          "Acme gateway did not answer. Your claim may have gone through. Try again: a repeat is safe.",
        );
        expect((yield* rpc.take("r2")).outcome).toBe("taken");
        const keys = company
          .writes()
          .slice(2)
          .map((c) => c.args.idempotencyKey);
        expect(keys).toHaveLength(3);
        expect(new Set(keys).size).toBe(1);
        expect(company.state.claimsApplied).toBe(2);

        // A new change after a definite answer has a new key.
        company.state.silent = 1;
        expect((yield* rpc.release("r2")).outcome).toBe("released");
        const [first, second] = company.writes().slice(-2);
        expect(second!.args.idempotencyKey).toBe(first!.args.idempotencyKey);
        expect(keys).not.toContain(first!.args.idempotencyKey);
      }),
    ),
  );

  it.live("refuses a second change to a task while one is running", () =>
    run(
      "provider-busy",
      Effect.gen(function* () {
        const { company } = yield* setUp("provider-busy");
        const [one, two] = yield* Effect.all(
          [Effect.result(rpc.take("r1")), Effect.result(rpc.take("r1"))],
          { concurrency: 2 },
        );
        expect([one._tag, two._tag].toSorted()).toEqual(["Failure", "Success"]);
        expect(company.writes()).toHaveLength(1);
      }),
    ),
  );

  // Saved by the release before this one: its tasks owner has no `leases` word.
  it.live("takes with the owners file the previous release saved", () =>
    run(
      "provider-old-file",
      Effect.gen(function* () {
        const { company } = yield* setUp("provider-old-file");
        const fs = yield* FileSystem.FileSystem;
        const file = `${(yield* ServerConfig).stateDir}/banneret/capability-owners/${relayHash(ORIGIN)}.json`;
        yield* fs.writeFileString(
          file,
          `{"key":"https://relay.example.test m_1","owners":{"tasks":{"owner":"external","source":"acme-gw","title":"Acme gateway","prefix":"acme_"}},"sources":[{"id":"acme-gw","title":"Acme gateway","url":"${company.url}","prefix":"acme_","provides":["tasks"],"auth":"bearer_per_person"}]}`,
        );
        expect((yield* rpc.take("r1")).outcome).toBe("taken");
      }),
    ),
  );

  it.live("keeps Banneret's own leases when Banneret owns tasks", () =>
    run(
      "provider-banneret",
      Effect.gen(function* () {
        const { t } = yield* setUp("provider-banneret");
        yield* t.publish({});
        expect(yield* ProviderLeases.externalTasks(ORIGIN)).toBeNull();
      }),
    ),
  );
});

describe("linking a thread to the task its agent claimed", () => {
  const approveNext = Effect.gen(function* () {
    const approvals = yield* approvalMachine(environmentId);
    const row = yield* approvals.updates.pipe(
      Stream.mapEffect(() => approvals.list()),
      Stream.filter((rows) => rows.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
      Effect.map((rows) => rows[0]!),
    );
    yield* approvals.decide(row.id, "once", "Ada", "");
  });

  it.live("follows the source's own claim and release answers, and nothing else", () =>
    run(
      "provider-link",
      Effect.gen(function* () {
        const mine: ThreadIssueLink = {
          tracker: "acme-jira" as never,
          host: "jira.example.test",
          scope: "PLAT",
          key: "PLAT-7",
          projectId: "project:mcp-test" as never,
          url: "https://jira.example.test/browse/PLAT-7",
          source: "manual",
          linkedAt: "2026-11-20T09:00:00.000Z",
          displayKey: "PLAT-7",
          title: "Linked by the person",
        };
        const { company, t, links } = yield* setUp("provider-link", [mine]);
        // A source that calls its claim a read still goes through approval.
        company.state.readOnlyClaim = true;
        const keys = () => links.map((link) => link.key);
        const call = (tool: string, args: object) =>
          Effect.gen(function* () {
            const held = yield* t.call("acme_" + tool, args).pipe(Effect.forkChild);
            yield* approveNext;
            return (yield* Fiber.join(held)).text;
          });
        const release = (taskId: string) =>
          call("tasks_release", { taskId, reason: "done", freeToContinue: false });

        // A read whose answer talks about a claim links nothing.
        company.state.cards[0]!.task.title = "claimed T1 {status: claimed}";
        yield* t.call("acme_tasks_read", { taskId: "T1" });
        expect(keys()).toEqual(["PLAT-7"]);
        company.state.cards[0]!.task.title = "Task PLAT-1";

        expect(yield* call("tasks_claim", { taskId: "T1" })).not.toContain("did not link");
        expect(keys()).toEqual(["PLAT-7", "PLAT-1"]);
        // From the source's own reading, and joined to the board for the work ring.
        expect(links[1]).toMatchObject({
          tracker: "acme-jira",
          host: "jira.example.test",
          title: "Task PLAT-1",
          url: "https://jira.example.test/browse/PLAT-1",
          source: "agent",
        });
        expect(
          taskIdForLinks([{ id: "r1", host: undefined, ...refOf("PLAT-1") }], [links[1]!]),
        ).toBe("r1");

        yield* call("tasks_claim", { taskId: "T2" });
        expect(keys()).toEqual(["PLAT-7", "PLAT-2"]);
        yield* release("T1");
        expect(keys()).toEqual(["PLAT-7", "PLAT-2"]);
        // Someone else's claim: a conflict links nothing.
        company.state.cards[0]!.lease = { holder: { id: "bob", login: "bob" }, state: "active" };
        yield* call("tasks_claim", { taskId: "T1" });
        expect(keys()).toEqual(["PLAT-7", "PLAT-2"]);
        yield* call("tasks_claim", { taskId: "missing" });
        expect(keys()).toEqual(["PLAT-7", "PLAT-2"]);
        yield* release("T2");
        expect(keys()).toEqual(["PLAT-7"]);

        // A reference a thread cannot keep is said in the tool's own answer.
        company.state.cards[1]!.task.ref.url = "jira:PLAT-2";
        expect(yield* call("tasks_claim", { taskId: "T2" })).toContain(
          "Banneret Hub did not link this chat to the Acme gateway task",
        );
        expect(keys()).toEqual(["PLAT-7"]);
      }),
    ),
  );

  it("moves the link only as the state table says, from the saved links alone", () => {
    const link = (key: string, source: "agent" | "manual" = "agent") =>
      ({
        ...linkFor(cardOf(key, key))!.key,
        source,
      }) as ThreadIssueLink;
    const a = linkFor(cardOf("A", "A"))!.key;
    const b = linkFor(cardOf("B", "B"))!.key;
    const rows = [
      // [saved links, answer, task, unlinked keys, links the task]
      [[], "claimed", a, [], true],
      [[link("A")], "claimed", a, [], false],
      [[link("A")], "claimed", b, ["A"], true],
      [[link("A")], "released", a, ["A"], false],
      [[link("A")], "released", b, [], false],
      [[link("A")], "conflict", b, [], false],
      [[link("A")], "not_holder", a, [], false],
      [[], undefined, a, [], false],
      // A person's own link is never moved, even to the task being released.
      [[link("A", "manual")], "claimed", b, [], true],
      [[link("A", "manual")], "released", a, [], false],
    ] as const;
    for (const [saved, status, task, unlinked, links] of rows) {
      const change = transition(saved, { status, task });
      expect([change.unlink.map((one) => one.key), change.link]).toEqual([unlinked, links]);
    }
  });
});
