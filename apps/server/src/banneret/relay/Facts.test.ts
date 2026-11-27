// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off globalTimersInEffect:off - a real HTTP relay (the fake) behind a recording forwarder.
import * as NodeOS from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type FakeRelay, loadSpec } from "@t3tools/banneret-relay-fake";
import {
  type BanneretWorkspace,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as Workspaces from "../Workspaces.ts";
import * as Enrolment from "./Enrolment.ts";
import * as Facts from "./Facts.ts";
import { projectKeyFromRemote } from "./projectKey.ts";
import { focus, type Forwarder, withFake } from "./relayHarness.testkit.ts";

const ENVIRONMENT = "env-facts-1";
const INTERVAL_MS = 200;
const FAST: Partial<Enrolment.EnrolmentOptions> = {
  pollFloorMs: 20,
  healthIntervalMs: INTERVAL_MS,
  maxBackoffMs: 100,
  counterSaveMs: 0,
};
const spec = loadSpec();
const EPOCH = Date.parse("2026-11-26T10:00:00Z");
const at = (ms: number) => DateTime.makeUnsafe(ms);
let ticks = 0;
/** A later fixed instant at each call, so every update moves `updatedAt`. */
const later = () => at(EPOCH + ++ticks * 1000);

interface World {
  projects: Facts.FactsProject[];
  threads: Facts.FactsThread[];
  providers: Facts.FactsProvider[];
  policyFingerprint: string | null;
}

const project = (name: string, remoteUrl: string, canonicalKey: string): Facts.FactsProject => ({
  id: ProjectId.make(`project-${name}`),
  workspaceRoot: `${NodeOS.homedir()}/src/${name}`,
  repositoryIdentity: {
    canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    rootPath: `${NodeOS.homedir()}/src/${name}`,
    displayName: canonicalKey,
  },
});

const ENTERPRISE = project(
  "company-app",
  "git@github.com:Example-Org/company-app.git",
  "github.com/example-org/company-app",
);
const SOLO = project(
  "side-quest",
  "https://github.com/someone/side-quest.git",
  "github.com/someone/side-quest",
);

const thread = (
  id: string,
  owner: Facts.FactsProject,
  overrides: Partial<Facts.FactsThread> = {},
): Facts.FactsThread & { readonly title: string; readonly worktreePath: string } => ({
  id: ThreadId.make(id),
  projectId: owner.id,
  title: `Secret plan for ${id}: sk-test-DO-NOT-LEAK`,
  worktreePath: `${owner.workspaceRoot}/.worktrees/${id}`,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  branch: "work/42-guild-invites",
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make(id),
  },
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

const claude = (usageLimits?: Facts.FactsProvider["usageLimits"]): Facts.FactsProvider => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  version: "2.1.0",
  auth: { status: "authenticated", email: "ada@example.com" },
  ...(usageLimits === undefined ? {} : { usageLimits }),
});

const readings = (windows: NonNullable<Facts.FactsProvider["usageLimits"]>["windows"]) => ({
  checkedAt: "2026-11-26T10:00:00.000Z",
  windows,
});

const emptyWorld = (): World => ({
  projects: [ENTERPRISE, SOLO],
  threads: [],
  providers: [claude()],
  policyFingerprint: null,
});

/** The facts source over a mutable world. It returns every thread, so the filter under test is Facts'. */
const factsLayer = (world: World) =>
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
        projects: Effect.sync(() => world.projects),
        threads: () => Effect.sync(() => world.threads),
        providers: Effect.sync(() => world.providers),
        policyFingerprint: Effect.sync(() => world.policyFingerprint),
      });
    }),
  );

const hubLayer = (baseDir: string, world: World) =>
  Enrolment.layerWith(FAST).pipe(
    Layer.provideMerge(factsLayer(world)),
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

const makeBaseDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "banneret-facts-" }));
}).pipe(Effect.provide(NodeServices.layer));

const statusOf = (origin: string) =>
  Effect.flatMap(Enrolment.BanneretEnrolment, (enrolment) => enrolment.status(origin));
const status = Effect.suspend(() => statusOf(focus.origin));

/** Re-reads `effect` at each enrolment change (every heartbeat is one) until `predicate` holds. */
const waitFor = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  timeoutMs = 5000,
) =>
  Effect.gen(function* () {
    const enrolment = yield* Enrolment.BanneretEnrolment;
    for (;;) {
      const changed = yield* enrolment.nextChange;
      const value = yield* effect;
      if (predicate(value)) return value;
      yield* changed;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.die(new Error(`timed out waiting for ${predicate.toString()}`)),
    }),
  );

interface FactsBody {
  readonly machine: Record<string, unknown>;
  readonly activity: ReadonlyArray<Facts.ActivityFact>;
  readonly usage?: ReadonlyArray<Facts.UsageFact>;
}

const factsRequests = (relay: Forwarder) =>
  relay.requests.filter(
    (request) => request.method === "POST" && request.url === "/relay/v1/facts",
  );
const factsBodies = (relay: Forwarder) =>
  factsRequests(relay).map((request) => JSON.parse(request.body) as FactsBody);

const waitForFacts = (
  relay: Forwarder,
  predicate: (body: FactsBody) => boolean,
  timeoutMs?: number,
) =>
  waitFor(
    Effect.sync(() => factsBodies(relay)),
    (bodies) => bodies.some(predicate),
    timeoutMs,
  ).pipe(Effect.map((bodies) => bodies.findLast(predicate)!));

/** Every request for a window of three heartbeat intervals. */
const requestsDuring = (relay: Forwarder) =>
  Effect.gen(function* () {
    relay.requests.length = 0;
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- proving silence needs a window; no event marks "no request was sent".
    yield* Effect.sleep(INTERVAL_MS * 3);
    return [...relay.requests];
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
    return yield* waitFor(statusOf(relay.origin), (current) => current.state === "configured");
  });

/** Puts the Enterprise project in the relay's workspace and the solo one in a Solo workspace. */
const assignProjects = (workspaceId: string) =>
  Effect.gen(function* () {
    const enterprise = (yield* Workspaces.list()).workspaces.find(
      (workspace) => workspace.id === workspaceId,
    )!;
    // Newer than the copy Enrolment wrote, so these claims win the merge.
    const now = "2100-01-01T00:00:00.000Z";
    const solo: BanneretWorkspace = {
      id: "solo-side",
      name: "Side projects",
      kind: "solo",
      projectKeys: [`repo:${SOLO.repositoryIdentity!.canonicalKey}`],
      updatedAt: now,
    };
    yield* Workspaces.put({
      workspaces: [
        {
          ...enterprise,
          projectKeys: [`repo:${ENTERPRISE.repositoryIdentity!.canonicalKey}`],
          updatedAt: now,
        },
        solo,
      ],
    });
  });

const expectValid = (body: unknown) => expect(spec.check("FactsRequest", body)).toBeNull();

const onFreshHub =
  (world: World) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(makeBaseDir, (baseDir) => Effect.provide(effect, hubLayer(baseDir, world)));

describe("BanneretFacts heartbeat", () => {
  it.live("an environment that is not enrolled makes no relay call", () => {
    const world = emptyWorld();
    world.threads = [thread("th-enterprise", ENTERPRISE)];
    return withFake((_fake, relay) =>
      Effect.gen(function* () {
        expect((yield* status).state).toBe("none");
        expect(yield* requestsDuring(relay)).toEqual([]);
      }).pipe(onFreshHub(world)),
    );
  });

  it.live("sends machine facts within one interval of joining, valid against the contract", () => {
    const world = emptyWorld();
    world.policyFingerprint = `sha256:${"ab".repeat(32)}`;
    return withFake((fake, relay) =>
      Effect.gen(function* () {
        yield* join(fake, relay);
        const body = yield* waitForFacts(relay, () => true, INTERVAL_MS * 3);
        expectValid(body);
        expect(body.machine).toMatchObject({
          environmentId: ENVIRONMENT,
          label: "Ada laptop",
          kind: "laptop",
          policyFingerprint: world.policyFingerprint,
          sandbox: { enabled: false, image: null },
        });
        expect(body.activity).toEqual([]);
        expect(body.usage).toBeUndefined();
        // The heartbeat is the health check: no further GET /capabilities while the version holds.
        relay.requests.length = 0;
        yield* waitFor(
          Effect.sync(() => factsRequests(relay).length),
          (count) => count >= 2,
        );
        expect(relay.requests.some((request) => request.url.includes("/capabilities"))).toBe(false);
        expect((yield* status).health).toBe("healthy");
        // A capabilities change is refetched once, on the next heartbeat.
        fake.bumpCapabilities();
        yield* waitFor(
          Effect.sync(() =>
            relay.requests.some((request) => request.url === "/relay/v1/capabilities"),
          ),
          Boolean,
        );
      }).pipe(onFreshHub(world)),
    );
  });

  it.live(
    "reports Enterprise threads through their states and nothing of a Solo project, its paths or remotes",
    () => {
      const world = emptyWorld();
      const solo = thread("th-solo-7f3a", SOLO);
      const work = thread("th-enterprise-1", ENTERPRISE);
      world.threads = [solo, work];
      return withFake((fake, relay) =>
        Effect.gen(function* () {
          const baseDir = yield* Effect.map(ServerConfig.ServerConfig, (config) => config.baseDir);
          const joined = yield* join(fake, relay);
          yield* assignProjects(joined.workspaceId!);

          const stateOf = (body: FactsBody) =>
            body.activity.find((fact) => fact.threadId === work.id);
          const working = stateOf(
            yield* waitForFacts(relay, (body) => stateOf(body)?.state === "working"),
          )!;
          expect(working).toMatchObject({
            projectKey: projectKeyFromRemote(ENTERPRISE.repositoryIdentity!.locator.remoteUrl),
            branch: "work/42-guild-invites",
            provider: "claude",
            providerVersion: "2.1.0",
            model: "claude-opus-5-5",
            processRunning: true,
          });
          expect(working.sessionId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

          const update = (overrides: Partial<Facts.FactsThread>) => {
            world.threads = [solo, { ...work, ...overrides, updatedAt: later() }];
          };
          update({
            status: "waiting",
            activityRunStatus: "waiting",
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("req-1"),
              kind: "command",
              createdAt: later(),
            },
          });
          yield* waitForFacts(
            relay,
            (body) => stateOf(body)?.state === "waiting" && stateOf(body)?.waiting === "permission",
          );
          update({
            status: "waiting",
            activityRunStatus: "waiting",
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("req-2"),
              kind: "user_input",
              createdAt: later(),
            },
          });
          yield* waitForFacts(relay, (body) => stateOf(body)?.waiting === "question");
          update({ status: "completed", activityRunStatus: null });
          const idle = stateOf(
            yield* waitForFacts(relay, (body) => stateOf(body)?.waiting === "input"),
          )!;
          expect(idle).toMatchObject({ state: "waiting", processRunning: false });
          update({ status: "failed", activityRunStatus: null, lastErrorClass: "usage_limit" });
          const stopped = stateOf(
            yield* waitForFacts(relay, (body) => stateOf(body)?.state === "stopped"),
          )!;
          expect(stopped).toMatchObject({ stopReason: "usage_limit", processRunning: false });
          // The session keeps its id through every state.
          expect(stopped.sessionId).toBe(working.sessionId);
          update({ settledAt: later(), settledOverride: "settled" });
          yield* waitForFacts(relay, (body) => body.activity.length === 0);

          const bodies = factsRequests(relay).map((request) => request.body);
          expect(bodies.length).toBeGreaterThan(4);
          for (const body of factsBodies(relay)) expectValid(body);
          const everything = bodies.join("\n");
          const secrets = [
            solo.id,
            solo.title,
            work.title,
            "sk-test-DO-NOT-LEAK",
            SOLO.id,
            ENTERPRISE.id,
            projectKeyFromRemote(SOLO.repositoryIdentity!.locator.remoteUrl)!,
            NodeOS.homedir(),
            process.cwd(),
            baseDir,
            work.worktreePath,
            ENTERPRISE.workspaceRoot,
            ENTERPRISE.repositoryIdentity!.locator.remoteUrl,
            ENTERPRISE.repositoryIdentity!.canonicalKey,
            SOLO.repositoryIdentity!.canonicalKey,
            "example-org",
            "someone",
          ];
          for (const secret of secrets) expect(everything).not.toContain(secret);
        }).pipe(onFreshHub(world)),
      );
    },
  );

  it.live(
    "with two companies joined, each relay gets only its own workspace's threads",
    () => {
      const OTHER = project(
        "oss-tool",
        "https://github.com/oss-org/oss-tool.git",
        "github.com/oss-org/oss-tool",
      );
      const world = { ...emptyWorld(), projects: [ENTERPRISE, OTHER, SOLO] };
      const mine = thread("th-company-a", ENTERPRISE);
      const theirs = thread("th-company-b", OTHER);
      const solo = thread("th-solo-9", SOLO);
      world.threads = [mine, theirs, solo];
      return withFake((fakeA, relayA) =>
        withFake((fakeB, relayB) =>
          Effect.gen(function* () {
            const joinedA = yield* join(fakeA, relayA);
            const joinedB = yield* join(fakeB, relayB);
            expect(joinedA.workspaceId).not.toBe(joinedB.workspaceId);
            yield* assignProjects(joinedA.workspaceId);
            const b = (yield* Workspaces.list()).workspaces.find(
              (workspace) => workspace.id === joinedB.workspaceId,
            )!;
            yield* Workspaces.put({
              workspaces: [
                {
                  ...b,
                  projectKeys: [`repo:${OTHER.repositoryIdentity!.canonicalKey}`],
                  updatedAt: "2100-01-01T00:00:00.000Z",
                },
              ],
            });

            const has = (id: string) => (body: FactsBody) =>
              body.activity.some((fact) => fact.threadId === id);
            yield* waitForFacts(relayA, has(mine.id));
            yield* waitForFacts(relayB, has(theirs.id));
            const sentA = factsRequests(relayA)
              .map((request) => request.body)
              .join("\n");
            const sentB = factsRequests(relayB)
              .map((request) => request.body)
              .join("\n");
            const keyOf = (owner: Facts.FactsProject) =>
              projectKeyFromRemote(owner.repositoryIdentity!.locator.remoteUrl)!;
            for (const leak of [theirs.id, solo.id, keyOf(OTHER), keyOf(SOLO)]) {
              expect(sentA).not.toContain(leak);
            }
            for (const leak of [mine.id, solo.id, keyOf(ENTERPRISE), keyOf(SOLO)]) {
              expect(sentB).not.toContain(leak);
            }
            // Each relay only ever hears from its own enrolment.
            const devices = (relay: Forwarder) =>
              new Set(relay.requests.map((request) => request.headers["x-banneret-device"]));
            expect(devices(relayA).has(joinedB.machineId)).toBe(false);
            expect(devices(relayB).has(joinedA.machineId)).toBe(false);
          }),
        ),
      ).pipe(onFreshHub(world));
    },
  );

  it.live("sends usage only when a reading is available, and only of the owner's logins", () => {
    const world = emptyWorld();
    return withFake((fake, relay) =>
      Effect.gen(function* () {
        yield* join(fake, relay);
        const first = yield* waitForFacts(relay, () => true);
        expect(first.usage).toBeUndefined();

        const resetsAt = "2026-11-26T14:00:00.000Z";
        world.providers = [
          claude(
            readings([
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 42.5,
                windowDurationMins: 300,
                resetsAt,
              },
              { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 17 },
              { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 5 },
            ]),
          ),
          {
            // A login behind a custom endpoint is not the owner's subscription.
            ...claude(
              readings([{ id: "five_hour", kind: "session", label: "S", usedPercent: 99 }]),
            ),
            instanceId: ProviderInstanceId.make("claude-proxy"),
            auth: { status: "authenticated", endpoint: "https://proxy.example" },
          },
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            version: "0.50.0",
            auth: { status: "authenticated" },
            usageLimits: {
              checkedAt: "2026-11-26T10:00:00.000Z",
              windows: [],
              unavailable: { reason: "probeFailed" },
            },
          },
        ];
        const body = yield* waitForFacts(relay, (candidate) => candidate.usage !== undefined);
        expectValid(body);
        expect(body.usage).toEqual([
          {
            provider: "claude",
            window: "5h",
            usedPercent: 42.5,
            resetsAt: resetsAt.replace(/\.\d{3}Z$/, "Z"),
          },
          { provider: "claude", window: "weekly", usedPercent: 17, resetsAt: null },
          { provider: "claude", window: "weekly_fable", usedPercent: 5, resetsAt: null },
        ]);
        expect(JSON.stringify(body)).not.toContain("ada@example.com");
      }).pipe(onFreshHub(world)),
    );
  });

  it.live("after Leave the environment makes no relay call", () => {
    const world = emptyWorld();
    world.threads = [thread("th-enterprise", ENTERPRISE)];
    return withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        yield* join(fake, relay);
        yield* waitForFacts(relay, () => true);
        expect(yield* enrolment.leave(relay.origin, "revoke")).toMatchObject({
          state: "none",
          reason: "left",
        });
        expect(yield* requestsDuring(relay)).toEqual([]);
      }).pipe(onFreshHub(world)),
    );
  });

  it.live("a 401 token_revoked on the heartbeat moves to revoked and goes quiet", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        yield* join(fake, relay);
        yield* waitForFacts(relay, () => true);
        relay.intercept = (request) =>
          request.url === "/relay/v1/facts"
            ? {
                status: 401,
                body: JSON.stringify({
                  error: { code: "token_revoked", message: "Gone.", retryable: false },
                }),
              }
            : undefined;
        const revoked = yield* waitFor(status, (view) => view.state === "revoked");
        expect(revoked.reason).toBe("removed");
        relay.intercept = undefined;
        expect(yield* requestsDuring(relay)).toEqual([]);
      }).pipe(onFreshHub(emptyWorld())),
    ),
  );

  it.live("backs off on 429 and 503, retries counter_reused once, and stays configured", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        yield* join(fake, relay);
        yield* waitForFacts(relay, () => true);
        let reused = 0;
        relay.intercept = (request) => {
          if (request.url !== "/relay/v1/facts") return undefined;
          if (reused === 0) {
            reused += 1;
            return {
              status: 401,
              body: JSON.stringify({
                error: { code: "counter_reused", message: "Seen.", retryable: false },
              }),
            };
          }
          return {
            status: 429,
            headers: { "retry-after": "0" },
            body: JSON.stringify({
              error: { code: "rate_limited", message: "Slow down.", retryable: true },
            }),
          };
        };
        const seen = yield* requestsDuring(relay);
        const facts = seen.filter((request) => request.url === "/relay/v1/facts");
        const counters = facts.map((request) =>
          BigInt(request.headers["x-banneret-counter"] as string),
        );
        expect(counters[1]! > counters[0]!).toBe(true);
        // Retry-After 0 is clamped to the 20 ms floor: at most one try per floor in the window.
        expect(facts.length).toBeLessThanOrEqual((INTERVAL_MS * 3) / 20 + 2);
        const view = yield* status;
        expect(view.state).toBe("configured");
        expect(view.health).toBe("unreachable");
        relay.intercept = undefined;
        yield* waitFor(status, (current) => current.health === "healthy");
      }).pipe(onFreshHub(emptyWorld())),
    ),
  );

  it.live("a restart resumes the heartbeat", () => {
    const world = emptyWorld();
    return withFake((fake, relay) =>
      Effect.gen(function* () {
        const baseDir = yield* makeBaseDir;
        yield* join(fake, relay).pipe(Effect.provide(hubLayer(baseDir, world)));
        relay.requests.length = 0;
        yield* Effect.gen(function* () {
          const body = yield* waitForFacts(relay, () => true);
          expectValid(body);
          expect(body.machine.kind).toBe("laptop");
        }).pipe(Effect.provide(hubLayer(baseDir, world)));
      }),
    );
  });
});

describe("Facts", () => {
  const relayOrigin = "https://relay.example";
  const enterprise = (projectKeys: string[], updatedAt = "2026-11-26T10:00:00.000Z") =>
    ({
      id: "ent-1",
      name: "Company",
      kind: "enterprise",
      projectKeys,
      relay: { origin: relayOrigin, displayName: "Company" },
      updatedAt,
    }) satisfies BanneretWorkspace;
  const repoKey = `repo:${ENTERPRISE.repositoryIdentity!.canonicalKey}`;

  it("a project a newer Solo workspace also claims is not Enterprise", () => {
    const solo: BanneretWorkspace = {
      id: "solo",
      name: "Mine",
      kind: "solo",
      projectKeys: [`path:${ENVIRONMENT}:${ENTERPRISE.workspaceRoot}`],
      updatedAt: "2026-11-26T11:00:00.000Z",
    };
    const input = { projects: [ENTERPRISE], relayOrigin, environmentId: ENVIRONMENT };
    expect(Facts.enterpriseProjects({ ...input, workspaces: [enterprise([repoKey])] }).size).toBe(
      1,
    );
    expect(
      Facts.enterpriseProjects({ ...input, workspaces: [enterprise([repoKey]), solo] }).size,
    ).toBe(0);
    // Another relay's Enterprise workspace, or a deleted one, does not count.
    expect(
      Facts.enterpriseProjects({
        ...input,
        workspaces: [
          {
            ...enterprise([repoKey]),
            relay: { origin: "https://other.example", displayName: "X" },
          },
        ],
      }).size,
    ).toBe(0);
    expect(
      Facts.enterpriseProjects({
        ...input,
        workspaces: [{ ...enterprise([repoKey]), deleted: true }],
      }).size,
    ).toBe(0);
  });

  it("skips threads whose id the contract cannot carry and providers it does not know", () => {
    const projects = new Map([[ENTERPRISE.id as string, "sha256:" + "0".repeat(64)]]);
    const facts = Facts.buildActivity({
      threads: [
        thread("th.with.dots", ENTERPRISE),
        thread("th-cursor", ENTERPRISE, { providerInstanceId: ProviderInstanceId.make("cursor") }),
        thread("th-ok", ENTERPRISE),
      ],
      projects,
      providers: [
        claude(),
        {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          version: null,
          auth: { status: "authenticated" },
        },
      ],
      sessions: new Map(),
    });
    expect(facts.map((fact) => fact.threadId)).toEqual(["th-ok"]);
  });

  it("links a live helper to its parent's session", () => {
    const projects = new Map([[ENTERPRISE.id as string, "sha256:" + "0".repeat(64)]]);
    const parent = thread("th-parent", ENTERPRISE);
    const helper = thread("th-helper", ENTERPRISE, {
      lineage: {
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
        rootThreadId: parent.id,
      },
    });
    const facts = Facts.buildActivity({
      threads: [
        parent,
        helper,
        { ...helper, id: ThreadId.make("th-done"), status: "completed", activityRunStatus: null },
      ],
      projects,
      providers: [claude()],
      sessions: new Map(),
    });
    const parentFact = facts.find((fact) => fact.threadId === "th-parent")!;
    expect(facts.find((fact) => fact.threadId === "th-helper")?.parentSessionId).toBe(
      parentFact.sessionId,
    );
    expect(facts.some((fact) => fact.threadId === "th-done")).toBe(false);
  });

  it("trims the least recently active sessions to stay under the body limit", () => {
    const fact = (index: number): Facts.ActivityFact => ({
      sessionId: `s_${index}`,
      threadId: `th-${index}`,
      projectKey: `sha256:${"0".repeat(64)}`,
      branch: "b".repeat(199),
      provider: "codex",
      state: "working",
      processRunning: true,
      startedAt: "2026-11-26T10:00:00Z",
      lastSeenAt: `2026-11-26T10:${String(index % 60).padStart(2, "0")}:00Z`,
    });
    const body = Facts.factsRequestBody(
      { policyFingerprint: null },
      {
        activity: Array.from({ length: 6000 }, (_, index) => fact(index)),
        usage: [],
        policyFingerprint: null,
      },
    );
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(Facts.MAX_BODY_BYTES);
    expect(body.activity.length).toBeGreaterThan(0);
    expect(body.activity[0]!.lastSeenAt).toBe("2026-11-26T10:59:00Z");
  });
});
