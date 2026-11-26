// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimersInEffect:off globalJsonInEffect:off globalTimers:off globalFetch:off globalFetchInEffect:off - a real HTTP relay (the fake) behind a streaming forwarder.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { FakeRelay } from "@t3tools/banneret-relay-fake";
import { type BanneretFeedEvent, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as Enrolment from "./Enrolment.ts";
import * as Facts from "./Facts.ts";
import * as RelayFeed from "./RelayFeed.ts";
import { type Forwarder, withFake } from "./relayHarness.testkit.ts";

const ENVIRONMENT_ID = "env-feed-1";
// The fake ages its event log by this clock only; the 24-hour reset moves it forward.
const FIXED_EPOCH_MS = 1_795_687_200_000;

const feedLayer = (baseDir: string) =>
  RelayFeed.layerWith({ retryMs: 30, maxRetryMs: 200, idleMs: 5000, connectMs: 2000 }).pipe(
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
        // Machine facts only; Facts.test.ts covers what the heartbeat reports.
        Facts.layerFromInputs({
          environmentId: ENVIRONMENT_ID,
          workspaces: Effect.succeed([]),
          projects: Effect.succeed([]),
          threads: () => Effect.succeed([]),
          providers: Effect.succeed([]),
          policyFingerprint: Effect.succeed(null),
        }),
        Layer.succeed(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make(ENVIRONMENT_ID)),
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const onFreshHub = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "banneret-feed-" }));
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.flatMap((baseDir) => Effect.provide(effect, feedLayer(baseDir))),
  );

/** The fake behind the shared recording forwarder, with a movable event-log clock. */
const withFakeClock = <A, E, R>(
  body: (fake: FakeRelay, relay: Forwarder, clock: { offsetMs: number }) => Effect.Effect<A, E, R>,
) => {
  const clock = { offsetMs: 0 };
  return withFake((fake, relay) => body(fake, relay, clock), {
    eventClock: () => FIXED_EPOCH_MS + clock.offsetMs,
  });
};

/** The fake's test-only control surface. */
const control = (fake: FakeRelay, path: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(`${fake.url}/conformance/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  });

const feed = RelayFeed.BanneretRelayFeed;

const waitForState = (state: string) =>
  Effect.gen(function* () {
    const enrolment = yield* Enrolment.BanneretEnrolment;
    for (;;) {
      const changed = yield* enrolment.nextChange;
      if ((yield* enrolment.status).state === state) return;
      yield* changed;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () => Effect.die(new Error(`timed out waiting for ${state}`)),
    }),
  );

const join = (fake: FakeRelay, relay: Forwarder) =>
  Effect.gen(function* () {
    const enrolment = yield* Enrolment.BanneretEnrolment;
    const view = yield* enrolment.start({
      origin: relay.origin,
      label: "Ada laptop",
      kind: "laptop",
    });
    fake.approve(view.confirmCode!, { login: "ada-example", role: "founder" });
    yield* waitForState("configured");
    return (yield* enrolment.status).machineId!;
  });

/** A client of the feed: every event it receives, and a way to wait for one. */
const subscribe = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<BanneretFeedEvent>();
  const service = yield* feed;
  yield* service.events.pipe(
    Stream.runForEach((event) => Queue.offer(queue, event)),
    Effect.forkScoped,
  );
  const next = (predicate: (event: BanneretFeedEvent) => boolean, label: string) =>
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

const isLive = (event: BanneretFeedEvent) => event.type === "snapshot" && event.live;
const isDown = (event: BanneretFeedEvent) => event.type === "snapshot" && !event.live;

const eventsRequests = (relay: Forwarder) =>
  relay.requests.filter((request) => request.url === "/relay/v1/events");

describe("protocolSupportsVisit", () => {
  it("allows visit=1 only from protocol 1.1 on", () => {
    expect(RelayFeed.protocolSupportsVisit("1.0")).toBe(false);
    expect(RelayFeed.protocolSupportsVisit("1.1")).toBe(true);
    expect(RelayFeed.protocolSupportsVisit("1.12")).toBe(true);
    expect(RelayFeed.protocolSupportsVisit("2.0")).toBe(true);
    expect(RelayFeed.protocolSupportsVisit(undefined)).toBe(false);
    expect(RelayFeed.protocolSupportsVisit("1")).toBe(false);
    expect(RelayFeed.protocolSupportsVisit("v1.1")).toBe(false);
  });
});

describe("BanneretRelayFeed", () => {
  it.live("makes no relay call while the environment has not joined, nor after Leave", () =>
    withFake((fake, relay) =>
      onFreshHub(
        Effect.gen(function* () {
          const client = yield* subscribe;
          const first = yield* client.next((event) => event.type === "snapshot", "snapshot");
          expect(first).toMatchObject({ joined: false, live: false });
          expect(yield* (yield* feed).today(true)).toEqual({
            joined: false,
            value: null,
            fetchedAt: null,
          });
          expect((yield* (yield* feed).needs(undefined)).joined).toBe(false);
          expect(relay.requests).toEqual([]);

          yield* join(fake, relay);
          yield* client.next(isLive, "live");
          const enrolment = yield* Enrolment.BanneretEnrolment;
          yield* enrolment.leave("revoke");
          yield* client.next(
            (event) => event.type === "snapshot" && !event.joined,
            "not joined after leave",
          );
          relay.requests.length = 0;
          // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- proving silence needs a window; no event marks "no request was sent".
          yield* Effect.sleep(500);
          expect(relay.requests).toEqual([]);
          expect((yield* (yield* feed).today(false)).joined).toBe(false);
          expect(relay.requests).toEqual([]);
        }),
      ),
    ),
  );

  it.live("proxies Today and pages Needs you in the relay's order", () =>
    withFake((fake, relay) =>
      onFreshHub(
        Effect.gen(function* () {
          const machineId = yield* join(fake, relay);
          yield* control(fake, "/needs", { machineId, count: 2, kind: "mention" });
          yield* control(fake, "/needs", { machineId, count: 1, kind: "zz_new_kind" });
          yield* control(fake, "/needs", { machineId, count: 55, kind: "thread_question" });

          const today = yield* (yield* feed).today(false);
          expect(today.joined).toBe(true);
          expect(today.value?.needsYou.items).toHaveLength(20);
          expect(today.value?.needsYou.nextCursor).not.toBeNull();
          expect(today.value?.needsYou.items[0]).toMatchObject({
            kind: "thread_question",
            deepLink: {
              environmentId: ENVIRONMENT_ID,
              threadId: "th_seeded",
              machineLabel: "Ada laptop",
            },
          });
          expect(today.value?.shipped.notMeasured[0]).toMatchObject({ reason: "not_configured" });

          const first = yield* (yield* feed).needs(undefined);
          expect(first.value?.items).toHaveLength(50);
          expect(first.value?.nextCursor).toEqual(expect.any(String));
          const second = yield* (yield* feed).needs(first.value!.nextCursor!);
          const kinds = [...first.value!.items, ...second.value!.items].map((item) => item.kind);
          expect(kinds).toEqual([
            ...Array.from({ length: 55 }, () => "thread_question"),
            "mention",
            "mention",
            "zz_new_kind",
          ]);
          expect(second.value?.nextCursor).toBeNull();
          // The token never reaches a reply.
          expect(JSON.stringify([today, first, second])).not.toMatch(/Bearer|token/i);
        }),
      ),
    ),
  );

  it.live("sends visit=1 only for an explicit open of Today", () =>
    withFake((fake, relay) =>
      onFreshHub(
        Effect.gen(function* () {
          yield* join(fake, relay);
          const service = yield* feed;
          yield* service.today(false);
          yield* service.today(false);
          expect(yield* control(fake, "/visits/read", { login: "ada-example" })).toEqual({
            lastVisitAt: null,
            lastReadAt: null,
          });
          yield* service.today(true);
          const after = yield* control(fake, "/visits/read", { login: "ada-example" });
          expect(after.lastReadAt).toEqual(expect.any(String));
          const todayTargets = relay.requests
            .map((request) => request.url)
            .filter((url) => url.startsWith("/relay/v1/today"));
          expect(todayTargets).toEqual([
            "/relay/v1/today",
            "/relay/v1/today",
            "/relay/v1/today?visit=1",
          ]);
        }),
      ),
    ),
  );

  it.live(
    "delivers relay events to a client, resumes with Last-Event-ID and refetches on reset",
    () =>
      withFakeClock((fake, relay, clock) =>
        onFreshHub(
          Effect.gen(function* () {
            const client = yield* subscribe;
            const machineId = yield* join(fake, relay);
            const live = yield* client.next(isLive, "live");
            expect(live).toMatchObject({
              joined: true,
              sections: expect.arrayContaining(["today", "needs"]),
            });

            yield* control(fake, "/needs", { machineId, count: 2, kind: "thread_question" });
            expect(
              yield* client.next((event) => event.type === "changed", "needs.changed"),
            ).toEqual({ type: "changed", reason: "needs", needsCount: 2 });

            // The stream drops; an event lands while it is down and is replayed on resume.
            yield* Effect.promise(() => relay.close());
            yield* client.next(isDown, "down");
            yield* control(fake, "/needs", { machineId, count: 1, kind: "mention" });
            yield* Effect.promise(() => relay.reopen());
            yield* client.next(isLive, "live again");
            const resumed = eventsRequests(relay).at(-1)!;
            expect(resumed.headers["last-event-id"]).toEqual(expect.stringMatching(/^[0-9]+$/));
            yield* client.next(
              (event) => event.type === "changed" && event.reason === "mention",
              "replayed mention",
            );
            yield* client.next(
              (event) => event.type === "changed" && event.needsCount === 3,
              "replayed needs.changed",
            );

            // Events the relay no longer holds: it sends reset, and the feed rereads capabilities.
            yield* Effect.promise(() => relay.close());
            yield* client.next(isDown, "down again");
            yield* control(fake, "/needs", { machineId, count: 1 });
            clock.offsetMs = 25 * 60 * 60 * 1000;
            relay.requests.length = 0;
            yield* Effect.promise(() => relay.reopen());
            yield* client.next(
              (event) => event.type === "changed" && event.reason === "reset",
              "reset",
            );
            expect(relay.requests.map((request) => request.url)).toContain(
              "/relay/v1/capabilities",
            );
            // A capabilities change reaches the client as a new snapshot.
            yield* control(fake, "/capabilities/bump", {});
            yield* client.next(
              (event) => event.type === "snapshot" && event.live,
              "snapshot after bump",
            );
          }),
        ),
      ),
  );

  it.live("keeps the last good answer, with its age, while the relay is away", () =>
    withFake((fake, relay) =>
      onFreshHub(
        Effect.gen(function* () {
          const machineId = yield* join(fake, relay);
          yield* control(fake, "/needs", { machineId, count: 3 });
          const service = yield* feed;
          const good = yield* service.today(false);
          const goodNeeds = yield* service.needs(undefined);
          yield* Effect.promise(() => relay.close());
          const away = yield* service.today(false);
          expect(away.value).toEqual(good.value);
          expect(away.fetchedAt).toBe(good.fetchedAt);
          expect(away.problem?.message).toBe("Cannot reach Example Company.");
          const awayNeeds = yield* service.needs(undefined);
          expect(awayNeeds.value).toEqual(goodNeeds.value);
          expect(awayNeeds.problem).toBeDefined();
        }),
      ),
    ),
  );
});
