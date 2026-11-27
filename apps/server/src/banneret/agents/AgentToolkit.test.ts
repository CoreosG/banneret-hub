// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off globalTimersInEffect:off globalFetch:off globalFetchInEffect:off - a real HTTP relay (the fake) behind a recording forwarder.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { FakeRelay } from "@t3tools/banneret-relay-fake";
import {
  allBoardCards,
  BANNERET_AGENT_TOOLS,
  type BanneretBoardCard,
  type BanneretEnrolmentView,
  type BanneretFeedState,
  type BanneretWorkspace,
  EnvironmentId,
  type OrchestrationProjectShell,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as IssueService from "../../issue/IssueService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadIssueService from "../../orchestration-v2/ThreadIssueService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as CommentEdits from "../lease/CommentEdits.ts";
import * as LeaseService from "../lease/LeaseService.ts";
import {
  addComment,
  commentEdits,
  type FakeTracker,
  issueService,
  ME,
  newTracker,
  OTHER,
  pullRequestService,
} from "../lease/leaseTracker.testkit.ts";
import * as Enrolment from "../relay/Enrolment.ts";
import * as Facts from "../relay/Facts.ts";
import * as RelayFeed from "../relay/RelayFeed.ts";
import { type Forwarder, withFake } from "../relay/relayHarness.testkit.ts";
import * as Workspaces from "../Workspaces.ts";
import * as AgentRelays from "./AgentRelays.ts";
import * as AgentHandlers from "./handlers.ts";
import { JOIN_LINE, JOIN_URI, joinText } from "./join.ts";
import * as AgentMcp from "./mcp.ts";
import { AgentToolkit } from "./tools.ts";

const ENVIRONMENT = "env-agents-1";
const ORIGIN = "https://relay.example.test";
const OTHER_ORIGIN = "https://other-relay.example.test";
const UPDATED_AT = "2100-01-01T00:00:00.000Z";

const project = (id: string, root: string) =>
  ({
    id: ProjectId.make(id),
    workspaceRoot: root,
    repositoryIdentity: null,
  }) as unknown as OrchestrationProjectShell;

const PROJECTS = new Map([
  ["project-company", project("project-company", "/work/company")],
  ["project-solo", project("project-solo", "/work/solo")],
  ["project-unjoined", project("project-unjoined", "/work/unjoined")],
]);

/** Each thread's project; a thread missing here fails to load, as after a broken database read. */
const THREAD_PROJECTS = new Map([
  ["thread-company1a2b3c4d", "project-company"],
  ["thread-solo", "project-solo"],
  ["thread-unjoined", "project-unjoined"],
]);
const COMPANY_THREAD = ThreadId.make("thread-company1a2b3c4d");

const workspace = (
  id: string,
  kind: "solo" | "enterprise",
  root: string,
  origin?: string,
): BanneretWorkspace => ({
  id,
  name: id,
  kind,
  projectKeys: [`path:${ENVIRONMENT}:${root}`],
  updatedAt: UPDATED_AT,
  ...(origin === undefined ? {} : { relay: { origin, displayName: "Example Company" } }),
});

const writeWorkspaces = (origin: string) =>
  Workspaces.put({
    workspaces: [
      workspace("ent-company", "enterprise", "/work/company", origin),
      workspace("ent-unjoined", "enterprise", "/work/unjoined", OTHER_ORIGIN),
      workspace("solo-personal", "solo", "/work/solo"),
    ],
  });

const threadsLayer = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadShell: (threadId) => {
    const projectId = THREAD_PROJECTS.get(threadId);
    return projectId === undefined
      ? Effect.die(new Error("the thread store is unavailable"))
      : Effect.succeed({ ...liveThreadShell(threadId), projectId: ProjectId.make(projectId) });
  },
});

const projectsLayer = Layer.mock(ProjectService.ProjectService)({
  getShell: (projectId) => Effect.succeed(Option.fromNullishOr(PROJECTS.get(projectId))),
});

const providersLayer = Layer.mock(ProviderRegistry)({
  getProviders: Effect.succeed([
    { instanceId: ProviderInstanceId.make("codex"), driver: "codex" } as unknown as ServerProvider,
  ]),
});

/** Thread-to-issue links the tools made, as `<thread> <scope>#<key> <source>`. */
const links: Array<string> = [];
const threadIssuesLayer = Layer.mock(ThreadIssueService.ThreadIssueService)({
  link: (input) =>
    Effect.sync(() => {
      links.push(`${input.threadId} ${input.ref.scope}#${input.ref.key} ${input.source}`);
      return { alreadyLinked: false };
    }),
});

const localLayer = (baseDir: string) =>
  Layer.mergeAll(
    threadsLayer,
    threadIssuesLayer,
    projectsLayer,
    providersLayer,
    Layer.succeed(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make(ENVIRONMENT)),
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "banneret-agents-" }));
}).pipe(Effect.provide(NodeServices.layer));

const card = (id: string, key: string, overrides: Partial<BanneretBoardCard> = {}) =>
  ({
    task: {
      id,
      title: `Task ${id}`,
      ref: {
        tracker: "github",
        scope: "example-org/example-app",
        key,
        url: `https://github.com/example-org/example-app/issues/${key}`,
      },
      openedAt: "2026-11-26T09:00:00.000Z",
      closedAt: null,
    },
    kind: "issue",
    column: "free",
    status: "planned",
    statusWhy: "Open, none of the above.",
    assignees: [],
    prs: [],
    restsOn: [],
    ...overrides,
  }) satisfies BanneretBoardCard;

const boardOf = (id: string, title: string, cards: ReadonlyArray<BanneretBoardCard>) => ({
  id,
  title,
  mode: "dev",
  source: { kind: "filter" },
  counts: { free: cards.length },
  board: { state: "ok", notMeasured: [], columns: [], cards: [...cards] },
});

/** Two boards: the first card on Platform, the rest on Ops. */
const boardState = (cards: ReadonlyArray<BanneretBoardCard>): BanneretFeedState => ({
  joined: true,
  live: true,
  since: "2026-11-26T09:59:00.000Z",
  sectionsKnown: true,
  sections: ["board"],
  needsCount: null,
  revision: 1,
  board: {
    value: {
      boards: [
        boardOf("platform", "Platform", cards.slice(0, 1)),
        boardOf("ops", "Ops", cards.slice(1)),
      ],
    },
    fetchedAt: "2026-11-26T10:00:00.000Z",
    atWork: [],
    leases: true,
    checked: false,
  },
  map: null,
  feed: null,
  graveyard: null,
});

describe("agent toolkit listing", () => {
  // Upstream's tools stand in as one plain tool: the agent tools must never hide or break it.
  const UpstreamToolkit = Toolkit.make(
    Tool.make("upstream_tool", {
      description: "An upstream tool.",
      success: Schema.Struct({}),
      failure: OrchestratorMcpFailure,
      failureMode: "return",
    }),
  );

  /** Relays asked anything by the stub feed, so a test can prove which relays were never asked. */
  const asked: Array<string> = [];

  const enrolmentStub = Layer.succeed(Enrolment.BanneretEnrolment, {
    ...Enrolment.BanneretEnrolment.defaultValue(),
    status: (relayOrigin: string) =>
      Effect.succeed<BanneretEnrolmentView>(
        relayOrigin === ORIGIN
          ? {
              state: "configured",
              workspaceId: "ent-company",
              relayOrigin,
              displayName: "Example Company",
              me: { login: ME, role: "limited_staff" },
            }
          : { state: "none", workspaceId: "ent-unjoined", relayOrigin },
      ),
  });

  const feedStub = Layer.succeed(RelayFeed.BanneretRelayFeed, {
    ...RelayFeed.BanneretRelayFeed.defaultValue(),
    // Withdraw is named for founders only, so a limited_staff person is not offered it.
    mcpTools: (relayOrigin: string) =>
      Effect.sync(() => {
        asked.push(relayOrigin);
        return BANNERET_AGENT_TOOLS.map((name) => ({
          name,
          role: name === "banneret_lease_withdraw" ? "founder" : "limited_staff",
        }));
      }),
    events: (relayOrigin: string) => {
      asked.push(relayOrigin);
      return Stream.make(boardState([card("t_free", "1"), card("t_mine", "2")]));
    },
  });

  const scopeFor = (
    token: string,
    threadId: string,
  ): McpInvocationContext.McpThreadInvocationScope => ({
    environmentId: EnvironmentId.make(ENVIRONMENT),
    requestNamespace: token,
    thread: {
      threadId: ThreadId.make(threadId),
      providerSessionId: token,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });
  const scopes = new Map([
    ["company", scopeFor("company", COMPANY_THREAD)],
    ["solo", scopeFor("solo", "thread-solo")],
    ["unjoined", scopeFor("unjoined", "thread-unjoined")],
    ["broken", scopeFor("broken", "thread-broken")],
  ]);

  it.effect(
    "offers the tools and the join resource only to a joined company's thread, as the relay names them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const baseDir = yield* tempDir;
          const local = localLayer(baseDir);
          yield* writeWorkspaces(ORIGIN).pipe(Effect.provide(local));
          // Composed as McpHttpServer's `layer` composes it: beside upstream's registrations, in one transport.
          const serverLayer = McpHttpServer.layerMcpTransport(
            Layer.mergeAll(
              McpHttpServer.toolkitRegistration(
                UpstreamToolkit,
                McpToolAccess.toLayer(UpstreamToolkit, {
                  upstream_tool: McpToolAccess.reads(() => Effect.succeed({})),
                }),
              ),
              AgentMcp.layer(McpHttpServer.toolkitRegistration),
            ),
          ).pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                resolve: (token) => Effect.succeed(scopes.get(token)),
              }),
            ),
            Layer.provide(Layer.mergeAll(enrolmentStub, feedStub)),
            Layer.provide(Layer.succeed(IssueService.IssueService, issueService(newTracker()))),
            Layer.provide(local),
          );
          yield* HttpRouter.serve(serverLayer, {
            disableListenLog: true,
            disableLogger: true,
          }).pipe(Layer.build);
          const httpClient = yield* HttpClient.HttpClient;
          const session = (token: string) =>
            Effect.gen(function* () {
              const headers = {
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${token}`,
              };
              const initialize = yield* httpClient.post("/mcp", {
                headers,
                body: HttpBody.text(
                  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                  "application/json",
                ),
              });
              const rpc = (method: string, params: object) =>
                httpClient
                  .post("/mcp", {
                    headers: {
                      ...headers,
                      "mcp-session-id": initialize.headers["mcp-session-id"]!,
                      "mcp-protocol-version": "2025-06-18",
                    },
                    body: HttpBody.text(
                      JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
                      "application/json",
                    ),
                  })
                  .pipe(
                    Effect.flatMap((response) => response.text),
                    Effect.map((text) =>
                      text
                        .split("\n")
                        .filter((line) => line.startsWith("data: ") || line.startsWith("{"))
                        .map(
                          (line) =>
                            JSON.parse(line.replace(/^data: /u, "")) as {
                              id?: number;
                              result?: Record<string, unknown>;
                              error?: { message: string };
                            },
                        )
                        .find((message) => message.id === 2)!,
                    ),
                  );
              return {
                tools: rpc("tools/list", {}).pipe(
                  Effect.map((body) =>
                    (body.result!.tools as ReadonlyArray<{ name: string }>)
                      .map((tool) => tool.name)
                      .sort(),
                  ),
                ),
                resources: rpc("resources/list", {}).pipe(
                  Effect.map((body) =>
                    ((body.result?.resources ?? []) as ReadonlyArray<{ uri: string }>).map(
                      (resource) => resource.uri,
                    ),
                  ),
                ),
                read: rpc("resources/read", { uri: JOIN_URI }),
                call: (name: string, args: object) => rpc("tools/call", { name, arguments: args }),
              };
            });

          const company = yield* session("company");
          expect(yield* company.tools).toEqual(
            [
              ...BANNERET_AGENT_TOOLS.filter((name) => name !== "banneret_lease_withdraw"),
              "upstream_tool",
            ].sort(),
          );
          expect(yield* company.resources).toEqual([JOIN_URI]);
          const join = (yield* company.read).result!.contents as ReadonlyArray<{ text: string }>;
          expect(join[0]!.text).toBe(joinText({ company: "Example Company", login: ME }));
          const board = (yield* company.call("banneret_board", { column: "free" })).result!
            .structuredContent as { company: string; me: string; cards: Array<{ id: string }> };
          expect(board).toMatchObject({ company: "Example Company", me: ME, leases: true });
          expect(board.cards.map((entry) => entry.id)).toEqual(["t_free", "t_mine"]);
          // One board by id; an unknown id names the boards there are.
          const ops = (yield* company.call("banneret_board", { board: "ops" })).result!
            .structuredContent as {
            boards: Array<{ id: string }>;
            cards: Array<{ id: string; board: string }>;
          };
          expect(ops.boards.map((entry) => entry.id)).toEqual(["platform", "ops"]);
          expect(ops.cards).toMatchObject([{ id: "t_mine", board: "ops" }]);
          const unknown = yield* company.call("banneret_board", { board: "nope" });
          expect(JSON.stringify(unknown.result ?? unknown.error)).toContain("platform, ops");
          // Named for founders only: hidden from this person, and a call is refused as unknown.
          expect(
            (yield* company.call("banneret_lease_withdraw", { taskId: "t_free" })).error,
          ).toBeDefined();

          asked.length = 0;
          for (const token of ["solo", "unjoined", "broken"]) {
            const other = yield* session(token);
            expect(yield* other.tools).toEqual(["upstream_tool"]);
            expect(yield* other.resources).toEqual([]);
            expect((yield* other.call("banneret_board", {})).error).toBeDefined();
            expect((yield* other.read).error).toBeDefined();
          }
          // Neither the Solo thread nor the thread of a relay this machine never joined asked any relay.
          expect(asked).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

describe("offeredTools", () => {
  it("enables only the Hub's own tools the relay names, at or below the person's role", () => {
    const tools = [
      { name: "banneret_board", role: "limited_staff" },
      { name: "banneret_lease_take", role: "founder" },
      { name: "banneret_task", role: "auditor" },
      { name: "needs_list", role: "limited_staff" },
    ];
    expect([...AgentRelays.offeredTools(tools, "limited_staff")]).toEqual(["banneret_board"]);
    expect([...AgentRelays.offeredTools(tools, "founder")].sort()).toEqual([
      "banneret_board",
      "banneret_lease_take",
    ]);
    // A role the Hub does not know admits only that exact role, and counts as the lowest otherwise.
    expect([...AgentRelays.offeredTools(tools, "auditor")].sort()).toEqual([
      "banneret_board",
      "banneret_task",
    ]);
  });
});

describe("join file", () => {
  it("states the lease rules for the thread's company and person", () => {
    const text = joinText({ company: "Example Company", login: "ada-example" });
    expect(text).toContain("# Leases at Example Company");
    expect(text).toContain("You work for ada-example at Example Company.");
    for (const rule of [
      "Check before you start.",
      "Take before you edit.",
      "Release with a reason when you stop, for any reason.",
      "Leave it free to continue",
      "Release before your usage runs out",
      "You can release only a lease ada-example holds.",
      "Do not call banneret_lease_check in a loop",
    ]) {
      expect(text).toContain(rule);
    }
    for (const tool of BANNERET_AGENT_TOOLS) expect(text).toContain(tool);
    expect(text).not.toMatch(/—/);
  });

  it.effect("keeps the one line to paste word for word in docs/banneret/agents.md", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const doc = yield* fs.readFileString(
        `${import.meta.dirname}/../../../../../docs/banneret/agents.md`,
      );
      expect(doc).toContain(JOIN_LINE);
      expect(JOIN_LINE).toContain(JOIN_URI);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// A real relay (the fake) for the board and the person; the tracker is the in-memory one LeaseService's tests
// use. Nothing here reaches a real tracker.
describe("agent lease tools against the fake relay", () => {
  const hubLayer = (baseDir: string, tracker: FakeTracker) =>
    Layer.mergeAll(
      AgentRelays.layer,
      LeaseService.layerWith({ readBackDelay: 0 }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(PullRequestService.PullRequestService, pullRequestService(tracker)),
            Layer.succeed(CommentEdits.CommentEdits, commentEdits(tracker)),
          ),
        ),
      ),
    ).pipe(
      Layer.provideMerge(Layer.succeed(IssueService.IssueService, issueService(tracker))),
      Layer.provideMerge(
        RelayFeed.layerWith({
          retryMs: 30,
          maxRetryMs: 200,
          idleMs: 5000,
          connectMs: 2000,
          snapshotPollMs: 100,
        }),
      ),
      Layer.provideMerge(
        Enrolment.layerWith({
          pollFloorMs: 20,
          healthIntervalMs: 150,
          maxBackoffMs: 100,
          counterSaveMs: 0,
        }),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          ServerSecretStore.layer,
          Facts.layerFromInputs({
            environmentId: ENVIRONMENT,
            workspaces: Effect.succeed([]),
            projects: Effect.succeed([]),
            threads: () => Effect.succeed([]),
            providers: Effect.succeed([]),
            policyFingerprint: Effect.succeed(null),
          }),
        ),
      ),
      Layer.provideMerge(localLayer(baseDir)),
    );

  const invocation = Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make(ENVIRONMENT),
    requestNamespace: "provider:agents",
    thread: {
      threadId: COMPANY_THREAD,
      providerSessionId: "provider:agents",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  });

  /** Runs `body` with the tools' handlers on a fresh Hub that uses `tracker`. */
  const onHub = <A, E, R>(tracker: FakeTracker, body: Effect.Effect<A, E, R>) =>
    Effect.flatMap(tempDir, (baseDir) =>
      body.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(AgentHandlers.layer).pipe(
            Layer.provideMerge(invocation),
            Layer.provideMerge(hubLayer(baseDir, tracker)),
          ),
        ),
      ),
    );

  const call = Effect.fn("call")(function* (name: keyof typeof AgentToolkit.tools, params: object) {
    const toolkit = yield* AgentToolkit;
    const parts = yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return parts.at(-1)?.result as Record<string, unknown>;
  });

  const control = (fake: FakeRelay, path: string, body: unknown) =>
    Effect.promise(async () => {
      const response = await fetch(`${fake.url}/conformance/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await response.json()) as Record<string, unknown>;
    });

  /** Joins the fake as ada-example and waits for the board with its seeded task. */
  const joinWithBoard = (fake: FakeRelay, relay: Forwarder) =>
    Effect.gen(function* () {
      yield* control(fake, "/board/seed", { tasks: [{ id: "t_free", title: "Rate limits" }] });
      const enrolment = yield* Enrolment.BanneretEnrolment;
      const view = yield* enrolment.start({
        origin: relay.origin,
        label: "Ada laptop",
        kind: "laptop",
      });
      fake.approve(view.confirmCode!, { login: ME, role: "limited_staff" });
      const feed = yield* RelayFeed.BanneretRelayFeed;
      yield* feed.events(relay.origin).pipe(
        Stream.filter((state) => allBoardCards(state.board?.value).length > 0),
        Stream.runHead,
      );
      yield* writeWorkspaces(relay.origin);
    }).pipe(
      Effect.timeoutOrElse({
        duration: 5000,
        orElse: () => Effect.die(new Error("timed out joining")),
      }),
    );

  it.live(
    "take and release write what the Board's buttons write, and never another person's lease",
    () =>
      withFake((fake, relay) =>
        Effect.gen(function* () {
          // The Board's path: LeaseService with the machine label as the agent.
          const board = newTracker();
          yield* onHub(
            board,
            Effect.gen(function* () {
              yield* joinWithBoard(fake, relay);
              const leases = yield* LeaseService.LeaseService;
              const resolved = yield* (yield* IssueService.IssueService).resolveUrl(
                "https://github.com/example-org/example-app/issues/1",
                ProjectId.make("project-company"),
              );
              const ref = {
                projectId: resolved.projectId,
                tracker: resolved.tracker,
                host: resolved.host,
                scope: resolved.scope,
                key: resolved.key,
                relayOrigin: relay.origin,
              };
              yield* leases.take({ ...ref, agent: "Ada-laptop" });
              yield* leases.release({
                ...ref,
                reason: "out_of_usage",
                freeToContinue: true,
                note: "**Next:** add the limiter",
              });
            }),
          );

          // The agent's path: the same task through the tools.
          const agent = newTracker();
          yield* onHub(
            agent,
            Effect.gen(function* () {
              yield* joinWithBoard(fake, relay);
              const listed = yield* call("banneret_board", { column: "free" });
              expect(listed).toMatchObject({ company: "Example Company", me: ME, leases: true });
              const taskId = (listed.cards as Array<{ id: string }>)[0]!.id;
              links.length = 0;
              expect(yield* call("banneret_lease_take", { taskId })).toMatchObject({
                outcome: "taken",
              });
              // Linked, so the thread's heartbeat names the task and keeps the lease fresh.
              expect(links).toEqual([`${COMPANY_THREAD} example-org/example-app#1 agent`]);
              expect(
                yield* call("banneret_lease_release", {
                  taskId,
                  reason: "out_of_usage",
                  note: "**Next:** add the limiter",
                }),
              ).toMatchObject({ outcome: "released" });
            }),
          );
          expect(agent.writes).toEqual(
            board.writes.map((write) =>
              write.replace(`claim: ${ME}/Ada-laptop`, `claim: ${ME}/codex-company1`),
            ),
          );
          expect(agent.writes[0]).toBe(`comment claim: ${ME}/codex-company1`);
          expect(agent.writes).toContain("comment release: out_of_usage · free to continue");

          // Someone else's lease: refused before anything is written.
          const held = newTracker({ assignees: [OTHER], labels: ["claimed"] });
          addComment(held, OTHER, `claim: ${OTHER}/hub`, 120);
          yield* onHub(
            held,
            Effect.gen(function* () {
              yield* joinWithBoard(fake, relay);
              const taskId = "t_free";
              expect(
                yield* call("banneret_lease_release", { taskId, reason: "done" }),
              ).toMatchObject({
                _tag: "TaskLeaseError",
                reason: "refused",
                detail: "You do not hold this task.",
              });
            }),
          );
          expect(held.writes).toEqual([]);
        }),
      ),
  );

  it.live("a machine that has not joined makes no relay call, and the tools refuse", () =>
    withFake((_fake, relay) =>
      onHub(
        newTracker(),
        Effect.gen(function* () {
          // The workspace names the relay, but this machine never joined it.
          yield* writeWorkspaces(relay.origin);
          for (const [name, params] of [
            ["banneret_board", {}],
            ["banneret_needs", {}],
            ["banneret_task", { taskId: "t_free" }],
            ["banneret_lease_check", { taskId: "t_free" }],
            ["banneret_lease_take", { taskId: "t_free" }],
          ] as const) {
            expect(yield* call(name, params)).toMatchObject({ code: "capability_denied" });
          }
          const relays = yield* AgentRelays.BanneretAgentRelays;
          expect((yield* relays.offered(COMPANY_THREAD)).size).toBe(0);
          expect(relay.requests).toEqual([]);
        }),
      ),
    ),
  );
});
