// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off globalTimersInEffect:off globalFetch:off globalFetchInEffect:off - a real HTTP relay (the fake) behind a recording forwarder.
import * as NodeOS from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { FakeRelay } from "@t3tools/banneret-relay-fake";
import {
  type BanneretFeedState,
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as Workspaces from "../Workspaces.ts";
import * as Enrolment from "./Enrolment.ts";
import * as Facts from "./Facts.ts";
import * as RelayFeed from "./RelayFeed.ts";
import { type Forwarder, withFake } from "./relayHarness.testkit.ts";
import { liveTaskIds, reshapeBoard, taskIdForLinks } from "./Snapshot.ts";

const ENVIRONMENT = "env-board-1";
const EPOCH = Date.parse("2026-11-26T10:00:00Z");
const at = (ms: number) => DateTime.makeUnsafe(ms);

interface World {
  threads: Facts.FactsThread[];
}

const PROJECT: Facts.FactsProject = {
  id: ProjectId.make("project-example-app"),
  workspaceRoot: `${NodeOS.homedir()}/src/example-app`,
  repositoryIdentity: {
    canonicalKey: "github.com/example-org/example-app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:example-org/example-app.git",
    },
    rootPath: `${NodeOS.homedir()}/src/example-app`,
    displayName: "example-org/example-app",
  },
};

const thread = (id: string, overrides: Partial<Facts.FactsThread> = {}): Facts.FactsThread => ({
  id: ThreadId.make(id),
  projectId: PROJECT.id,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  branch: "work/unrelated-name",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  status: "running",
  activityRunStatus: "running",
  pendingRuntimeRequest: null,
  latestRunId: RunId.make(`run-${id}`),
  latestRunStartedAt: at(EPOCH - 60_000),
  lastErrorClass: null,
  createdAt: at(EPOCH - 120_000),
  updatedAt: at(EPOCH),
  settledAt: null,
  settledOverride: null,
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

/** A thread linked to issue `key` of example-org/example-app, as upstream's issue panel links it. */
const linkedTo = (key: string): Pick<Facts.FactsThread, "issues"> => ({
  issues: [
    {
      tracker: IssueTrackerKind.make("github"),
      host: "github.com",
      scope: "Example-Org/example-app",
      key,
      projectId: PROJECT.id,
      url: `https://github.com/example-org/example-app/issues/${key}`,
      source: "manual",
      linkedAt: "2026-11-26T09:00:00.000Z",
      displayKey: `#${key}`,
      title: "Linked issue",
    },
  ],
});

const hubLayer = (
  baseDir: string,
  world: World,
  timing: { readonly healthIntervalMs: number; readonly snapshotPollMs: number },
) =>
  RelayFeed.layerWith({
    retryMs: 30,
    maxRetryMs: 200,
    idleMs: 5000,
    connectMs: 2000,
    snapshotPollMs: timing.snapshotPollMs,
  }).pipe(
    Layer.provideMerge(
      Enrolment.layerWith({
        pollFloorMs: 20,
        healthIntervalMs: timing.healthIntervalMs,
        maxBackoffMs: 100,
        counterSaveMs: 0,
      }),
    ),
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const context = yield* Effect.context<
            ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
          >();
          return Facts.layerFromInputs({
            environmentId: ENVIRONMENT,
            workspaces: Workspaces.list().pipe(
              Effect.map((list) => list.workspaces),
              Effect.provideContext(context),
            ),
            projects: Effect.succeed([PROJECT]),
            threads: () => Effect.sync(() => world.threads),
            providers: Effect.succeed([
              {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                driver: ProviderDriverKind.make("claudeAgent"),
                version: "2.1.0",
                auth: { status: "authenticated" },
              },
            ]),
            policyFingerprint: Effect.succeed(null),
          });
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        ServerSecretStore.layer,
        Layer.succeed(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make(ENVIRONMENT)),
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const onFreshHub =
  (world: World, timing = { healthIntervalMs: 150, snapshotPollMs: 100 }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "banneret-board-" }));
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.flatMap((baseDir) => Effect.provide(effect, hubLayer(baseDir, world, timing))),
    );

const control = (fake: FakeRelay, path: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(`${fake.url}/conformance/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  });

const join = (fake: FakeRelay, relay: Forwarder) =>
  Effect.gen(function* () {
    const enrolment = yield* Enrolment.BanneretEnrolment;
    const view = yield* enrolment.start({
      origin: relay.origin,
      label: "Ada laptop",
      kind: "laptop",
    });
    fake.approve(view.confirmCode!, { login: "ada-example", role: "founder" });
    for (;;) {
      const changed = yield* enrolment.nextChange;
      const current = yield* enrolment.status;
      if (current.state === "configured") return current;
      yield* changed;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () => Effect.die(new Error("timed out joining")),
    }),
  );

/** Puts the project in the relay's Enterprise workspace, so its threads are reported. */
const assignProject = (workspaceId: string) =>
  Effect.gen(function* () {
    const enterprise = (yield* Workspaces.list()).workspaces.find(
      (workspace) => workspace.id === workspaceId,
    )!;
    yield* Workspaces.put({
      workspaces: [
        {
          ...enterprise,
          projectKeys: [`repo:${PROJECT.repositoryIdentity!.canonicalKey}`],
          updatedAt: "2100-01-01T00:00:00.000Z",
        },
      ],
    });
  });

/** Every feed state the server publishes, and a way to wait for one. */
const subscribe = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<BanneretFeedState>();
  const feed = yield* RelayFeed.BanneretRelayFeed;
  yield* feed.events.pipe(
    Stream.runForEach((event) => Queue.offer(queue, event)),
    Effect.forkScoped,
  );
  const next = (predicate: (event: BanneretFeedState) => boolean, label: string) =>
    Effect.gen(function* () {
      for (;;) {
        const event = yield* Queue.take(queue);
        if (predicate(event)) return event;
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: 5000,
        orElse: () => Effect.die(new Error(`timed out waiting for ${label}`)),
      }),
    );
  return { next };
});

const leaseOf = (event: BanneretFeedState, taskId: string) =>
  event.board?.value?.cards.find((card) => card.task.id === taskId)?.lease?.state;

/** Waits until `done` holds, rechecking at each enrolment change (every signed call is one). */
const untilEnrolment = (done: () => boolean, label: string) =>
  Effect.gen(function* () {
    const enrolment = yield* Enrolment.BanneretEnrolment;
    for (;;) {
      const changed = yield* enrolment.nextChange;
      if (done()) return;
      yield* changed;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () => Effect.die(new Error(`timed out waiting for ${label}`)),
    }),
  );

const isHead = (url: string) => url === "/relay/v1/snapshot/head";
const isFile = (url: string) => url.startsWith("/relay/v1/snapshot/files/");

const SEED = {
  tasks: [
    { id: "t_free", title: "Rate limits" },
    { id: "t_active", title: "Guild invites", holder: "bo-example", column: "taken" },
    { id: "t_stale", title: "Profile blocks", holder: "cy-example", column: "taken" },
    { id: "t_expired", title: "Search", holder: "di-example", column: "taken" },
  ],
};

describe("BanneretRelayFeed board from the snapshot", () => {
  it.live("an environment that has not joined reads no snapshot, nor anything else", () =>
    withFake((_fake, relay) =>
      Effect.gen(function* () {
        const events = yield* subscribe;
        const first = yield* events.next(() => true, "the first state");
        expect(first.joined).toBe(false);
        expect(first.board).toBeNull();
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- proving silence needs a window; no event marks "no request was sent".
        yield* Effect.sleep(400);
        expect(relay.requests).toEqual([]);
      }).pipe(onFreshHub({ threads: [] })),
    ),
  );

  it.live("reads the head, fetches each file once by hash, and a 304 fetches nothing", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const events = yield* subscribe;
        yield* join(fake, relay);
        yield* control(fake, "/board/seed", SEED);
        yield* control(fake, "/lease/age", { taskId: "t_stale", hours: 7 });
        yield* control(fake, "/lease/age", { taskId: "t_expired", hours: 25 });
        const state = yield* events.next(
          (event) =>
            leaseOf(event, "t_stale") === "stale" && leaseOf(event, "t_expired") === "expired",
          "the aged board",
        );
        const board = state.board!;
        expect(board.leases).toBe(true);
        expect(board.fetchedAt).not.toBeNull();
        expect(board.problem).toBeUndefined();
        expect(board.value!.columns.map((column) => column.title)).toEqual([
          "Free",
          "Taken",
          "Validating",
          "Stuck",
          "Shipped",
        ]);
        const columnOf = (id: string) =>
          board.value!.cards.find((card) => card.task.id === id)?.column;
        expect(columnOf("t_free")).toBe("free");
        expect(columnOf("t_active")).toBe("taken");
        expect(columnOf("t_stale")).toBe("stuck");
        expect(columnOf("t_expired")).toBe("stuck");
        expect(leaseOf(state, "t_active")).toBe("active");
        expect(board.value!.cards.find((card) => card.task.id === "t_free")?.lease).toBeUndefined();

        // A long heartbeat interval leaves the head unchanged, so the polls answer 304.
        const files = relay.requests.filter((request) => isFile(request.url));
        expect(files.length).toBeGreaterThan(0);
        expect(new Set(files.map((request) => request.url)).size).toBe(files.length);
        relay.requests.length = 0;
        yield* untilEnrolment(
          () =>
            relay.requests.filter((request) => isHead(request.url) && request.status === 304)
              .length >= 2,
          "two 304 heads",
        );
        const heads = relay.requests.filter((request) => isHead(request.url));
        expect(heads.filter((request) => request.status === 304).length).toBeGreaterThanOrEqual(2);
        for (const head of heads) expect(head.headers["if-none-match"]).toMatch(/^"sha256:/);
        expect(relay.requests.filter((request) => isFile(request.url))).toEqual([]);
      }).pipe(onFreshHub({ threads: [] }, { healthIntervalMs: 60_000, snapshotPollMs: 100 })),
    ),
  );

  it.live("reads the head again when a file answers 404", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        let refused = 0;
        relay.intercept = (request) => {
          if (!isFile(request.url) || refused > 0) return undefined;
          refused += 1;
          return {
            status: 404,
            body: JSON.stringify({
              error: { code: "not_found", message: "Not found.", retryable: false },
            }),
          };
        };
        const events = yield* subscribe;
        yield* control(fake, "/board/seed", SEED);
        yield* join(fake, relay);
        yield* events.next((event) => (event.board?.value?.cards.length ?? 0) === 4, "the board");
        expect(refused).toBe(1);
        const urls = relay.requests.map((request) => request.url);
        const refusedAt = relay.requests.findIndex((request) => request.status === 404);
        const after = urls.slice(refusedAt + 1);
        // The next snapshot call is the head, read without If-None-Match, then the file again.
        const nextHead = relay.requests
          .slice(refusedAt + 1)
          .find((request) => isHead(request.url) || isFile(request.url))!;
        expect(isHead(nextHead.url)).toBe(true);
        expect(nextHead.headers["if-none-match"]).toBeUndefined();
        expect(after).toContain(urls[refusedAt]);
      }).pipe(onFreshHub({ threads: [] })),
    ),
  );

  it.live("refuses a file that does not match its hash and keeps the last good board", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const events = yield* subscribe;
        yield* control(fake, "/board/seed", SEED);
        yield* join(fake, relay);
        const good = yield* events.next(
          (event) => (event.board?.value?.cards.length ?? 0) === 4,
          "the board",
        );
        relay.rewrite = (request, body) =>
          isFile(request.url) ? body.replace(/"Rate limits"/g, '"Tampered"') : body;
        yield* control(fake, "/board/seed", { tasks: [{ id: "t_new", title: "Rate limits" }] });
        const refused = yield* events.next(
          (event) => event.board?.problem !== undefined,
          "the refused file",
        );
        expect(refused.board!.problem!.message).toContain("did not match relay v1");
        expect(refused.board!.value).toEqual(good.board!.value);
        expect(refused.board!.fetchedAt).not.toBeNull();

        relay.rewrite = undefined;
        const fixed = yield* events.next(
          (event) => event.board?.problem === undefined && event.board?.value?.cards.length === 1,
          "the new board",
        );
        expect(fixed.board!.value!.cards[0]!.task.title).toBe("Rate limits");
      }).pipe(onFreshHub({ threads: [] })),
    ),
  );

  it.live("keeps the last good board with its age while the relay is away", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const events = yield* subscribe;
        yield* control(fake, "/board/seed", SEED);
        yield* join(fake, relay);
        const good = yield* events.next(
          (event) => (event.board?.value?.cards.length ?? 0) === 4,
          "the board",
        );
        yield* Effect.promise(() => relay.close());
        const away = yield* events.next(
          (event) => event.board?.problem !== undefined,
          "the relay away",
        );
        expect(away.board!.problem!.message).toBe(
          `Cannot reach ${(yield* (yield* Enrolment.BanneretEnrolment).status).displayName}.`,
        );
        expect(away.board!.value).toEqual(good.board!.value);
        expect(away.board!.fetchedAt).not.toBeNull();

        yield* Effect.promise(() => relay.reopen());
        yield* events.next(
          (event) => event.board?.problem === undefined && event.board?.value !== null,
          "the relay back",
        );
      }).pipe(onFreshHub({ threads: [] })),
    ),
  );

  it.live(
    "sends the board task id of a thread's linked issue, which keeps that lease active",
    () => {
      const world: World = { threads: [] };
      return withFake((fake, relay) =>
        Effect.gen(function* () {
          const events = yield* subscribe;
          // The fake names card N issue N of example-org/example-app; neither task has a branch.
          yield* control(fake, "/board/seed", {
            tasks: [
              { id: "t_other", title: "Other", holder: "bo-example" },
              { id: "t_linked", title: "Linked", holder: "ada-example" },
            ],
          });
          yield* control(fake, "/lease/age", { taskId: "t_linked", hours: 7 });
          yield* control(fake, "/lease/age", { taskId: "t_other", hours: 7 });
          const joined = yield* join(fake, relay);
          yield* assignProject(joined.workspaceId!);
          world.threads = [thread("th-linked", linkedTo("2")), thread("th-plain")];

          const active = yield* events.next(
            (event) => leaseOf(event, "t_linked") === "active",
            "the linked lease back to active",
          );
          // The heartbeat matched the task by id alone: the other stale lease stays stale.
          expect(leaseOf(active, "t_other")).toBe("stale");

          const bodies = relay.requests
            .filter((request) => request.method === "POST" && request.url === "/relay/v1/facts")
            .map((request) => JSON.parse(request.body) as { activity: Facts.ActivityFact[] });
          const facts = bodies.flatMap((body) => body.activity);
          expect(
            facts.some((fact) => fact.threadId === "th-linked" && fact.taskId === "t_linked"),
          ).toBe(true);
          expect(
            facts
              .filter((fact) => fact.threadId === "th-plain")
              .every((fact) => fact.taskId === undefined),
          ).toBe(true);
        }).pipe(onFreshHub(world)),
      );
    },
  );
});

describe("snapshot reshaping", () => {
  it("joins the work file's live sessions by task id", () => {
    const work = {
      working: {
        items: [
          { person: { login: "ada" }, task: { id: "t_1" }, state: "working" },
          { person: { login: "bo" }, task: { id: "t_2" }, state: "waiting" },
          { person: { login: "cy" }, task: { id: "t_3" }, state: "idle" },
          { person: { login: "di" }, task: { id: "t_4" }, state: "not_heard_from" },
          { person: { login: "ed" }, state: "working" },
        ],
      },
    };
    expect(liveTaskIds(work)).toEqual(["t_1", "t_2"]);
    expect(liveTaskIds(null)).toEqual([]);
  });

  it("matches a linked issue on tracker, host, scope and key, and drops a malformed card", () => {
    const board = reshapeBoard({
      state: "ok",
      notMeasured: [],
      columns: [{ id: "free", title: "Free" }],
      cards: [
        {
          task: {
            id: "t_gh",
            title: "A",
            ref: { tracker: "github", scope: "example-org/app", key: "7", url: "https://x" },
          },
          column: "free",
          status: "planned",
          statusWhy: "Open.",
          restsOn: [],
        },
        {
          task: {
            id: "t_ghe",
            title: "B",
            ref: {
              tracker: "github",
              host: "ghe.example.com",
              scope: "example-org/app",
              key: "8",
              url: "https://y",
            },
          },
          column: "free",
          status: "planned",
          statusWhy: "Open.",
          restsOn: [],
        },
        { task: { id: "t_bad" }, column: "free" },
      ],
    })!;
    expect(board.cards.map((card) => card.task.id)).toEqual(["t_gh", "t_ghe"]);
    const index = board.cards.map((card) => ({
      id: card.task.id,
      tracker: card.task.ref.tracker,
      host: card.task.ref.host,
      scope: card.task.ref.scope,
      key: card.task.ref.key,
    }));
    const link = (host: string, key: string) => ({
      tracker: "github",
      host,
      scope: "Example-Org/App",
      key,
    });
    expect(taskIdForLinks(index, [link("github.com", "7")])).toBe("t_gh");
    expect(taskIdForLinks(index, [link("github.com", "8")])).toBeUndefined();
    expect(taskIdForLinks(index, [link("GHE.example.com", "8")])).toBe("t_ghe");
    expect(taskIdForLinks(index, [link("github.com", "9"), link("github.com", "7")])).toBe("t_gh");
    expect(taskIdForLinks(index, [])).toBeUndefined();
  });
});
