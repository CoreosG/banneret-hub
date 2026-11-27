// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimersInEffect:off globalJsonInEffect:off globalTimers:off globalFetch:off globalFetchInEffect:off - a real HTTP relay (the fake) behind a streaming forwarder.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { FakeRelay } from "@t3tools/banneret-relay-fake";
import {
  type BanneretFeedState,
  type BanneretFeedTodayRead,
  EnvironmentId,
} from "@t3tools/contracts";
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
import { focus, type Forwarder, withFake } from "./relayHarness.testkit.ts";

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

const waitForState = (state: string, origin = focus.origin) =>
  Effect.gen(function* () {
    const enrolment = yield* Enrolment.BanneretEnrolment;
    for (;;) {
      const changed = yield* enrolment.nextChange;
      if ((yield* enrolment.status(origin)).state === state) return;
      yield* changed;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () => Effect.die(new Error(`timed out waiting for ${state}`)),
    }),
  );

/** The feed of the relay under test (the one `withFake` started last). */
const focusedFeed = Effect.map(RelayFeed.BanneretRelayFeed, (service) => ({
  today: (since?: string) => service.today(focus.origin, since),
  needs: (cursor: string | undefined) => service.needs(focus.origin, cursor),
  feedPage: (cursor: string) => service.feedPage(focus.origin, cursor),
  graveyardPage: (cursor: string) => service.graveyardPage(focus.origin, cursor),
  task: (taskId: string) => service.task(focus.origin, taskId),
  events: Stream.suspend(() => service.events(focus.origin)),
}));

const feed = focusedFeed;

const join = (fake: FakeRelay, relay: Forwarder) =>
  Effect.gen(function* () {
    const enrolment = yield* Enrolment.BanneretEnrolment;
    const view = yield* enrolment.start({
      origin: relay.origin,
      label: "Ada laptop",
      kind: "laptop",
    });
    fake.approve(view.confirmCode!, { login: "ada-example", role: "founder" });
    yield* waitForState("configured", relay.origin);
    return (yield* enrolment.status(relay.origin)).machineId!;
  });

/** A client of one relay's feed: every event it receives, and a way to wait for one. */
const subscribeTo = Effect.fn("subscribeTo")(function* (origin: string) {
  const queue = yield* Queue.unbounded<BanneretFeedState>();
  const service = yield* RelayFeed.BanneretRelayFeed;
  yield* service.events(origin).pipe(
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
const subscribe = Effect.suspend(() => subscribeTo(focus.origin));

const isLive = (event: BanneretFeedState) => event.live;
const isDown = (event: BanneretFeedState) => event.joined && !event.live;

const eventsRequests = (relay: Forwarder) =>
  relay.requests.filter((request) => request.url === "/relay/v1/events");

describe("BanneretRelayFeed", () => {
  it.live("recovers channel messages written while the event stream is disconnected", () =>
    withFake(
      (fake, relay) =>
        onFreshHub(
          Effect.gen(function* () {
            const feed = yield* RelayFeed.BanneretRelayFeed;
            const client = yield* subscribe;
            yield* join(fake, relay);
            yield* client.next(isLive, "chat live");
            expect(yield* feed.chat(relay.origin, { kind: "join", id: "c_general" })).toMatchObject(
              { ok: true },
            );
            relay.intercept = (r) => (r.url === "/relay/v1/events" ? { status: 503 } : undefined);
            yield* Effect.promise(() => relay.close());
            yield* client.next(isDown, "chat down");
            yield* Effect.promise(() => relay.reopen());
            for (const text of ["First missed post", "Second missed post"]) {
              expect(
                yield* feed.chat(relay.origin, {
                  kind: "post",
                  id: "c_general",
                  text,
                  key: text.replaceAll(" ", "-"),
                }),
              ).toMatchObject({ ok: true });
            }
            const recovered: string[] = [];
            relay.rewrite = (req, body) => {
              if (req.url.startsWith("/relay/v1/chat/changes?"))
                for (const change of JSON.parse(body).items) {
                  if (change.kind === "message.created") recovered.push(change.message.text);
                }
              return body;
            };
            relay.intercept = undefined;
            yield* client.next(isLive, "chat reconnected");
            expect(recovered).toEqual(["First missed post", "Second missed post"]);
            expect(
              yield* feed.chat(relay.origin, { kind: "messages", id: "c_general" }),
            ).toMatchObject({
              ok: true,
              value: { items: [{ text: "Second missed post" }, { text: "First missed post" }] },
            });
          }),
        ),
      { chat: true },
    ),
  );

  it.live("makes no relay call while the environment has not joined, nor after Leave", () =>
    withFake((fake, relay) =>
      onFreshHub(
        Effect.gen(function* () {
          const client = yield* subscribe;
          const first = yield* client.next(() => true, "snapshot");
          expect(first).toMatchObject({ joined: false, live: false });
          expect(yield* (yield* feed).today()).toEqual({
            joined: false,
            value: null,
            fetchedAt: null,
          });
          expect((yield* (yield* feed).needs(undefined)).joined).toBe(false);
          expect(relay.requests).toEqual([]);

          yield* join(fake, relay);
          yield* client.next(isLive, "live");
          const enrolment = yield* Enrolment.BanneretEnrolment;
          yield* enrolment.leave(focus.origin, "revoke");
          yield* client.next((event) => !event.joined, "not joined after leave");
          relay.requests.length = 0;
          // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- proving silence needs a window; no event marks "no request was sent".
          yield* Effect.sleep(500);
          expect(relay.requests).toEqual([]);
          expect((yield* (yield* feed).today()).joined).toBe(false);
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

          const today = yield* (yield* feed).today();
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

  it.live("forwards the device cutoff only as a since query", () =>
    withFake((fake, relay) =>
      onFreshHub(
        Effect.gen(function* () {
          yield* join(fake, relay);
          const service = yield* feed;
          yield* service.today();
          yield* service.today("2026-11-26T10:00:00Z");
          const todayTargets = relay.requests
            .map((request) => request.url)
            .filter((url) => url.startsWith("/relay/v1/today"));
          expect(todayTargets).toEqual([
            "/relay/v1/today",
            "/relay/v1/today?since=2026-11-26T10%3A00%3A00Z",
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
            const changed = yield* client.next(
              (event) => event.revision > live.revision,
              "needs.changed",
            );
            expect(changed.needsCount).toBe(2);

            // The stream drops; an event lands while it is down and is replayed on resume.
            yield* Effect.promise(() => relay.close());
            yield* client.next(isDown, "down");
            yield* control(fake, "/needs", { machineId, count: 1, kind: "mention" });
            yield* Effect.promise(() => relay.reopen());
            yield* client.next(isLive, "live again");
            const resumed = eventsRequests(relay).at(-1)!;
            expect(resumed.headers["last-event-id"]).toEqual(expect.stringMatching(/^[0-9]+$/));
            const replayed = yield* client.next(
              (event) => event.needsCount === 3,
              "replayed needs.changed",
            );
            expect(replayed.revision).toBeGreaterThan(changed.revision);

            // Events the relay no longer holds: it sends reset, and the feed rereads capabilities.
            yield* Effect.promise(() => relay.close());
            yield* client.next(isDown, "down again");
            yield* control(fake, "/needs", { machineId, count: 1 });
            clock.offsetMs = 25 * 60 * 60 * 1000;
            relay.requests.length = 0;
            yield* Effect.promise(() => relay.reopen());
            // The reset clears the count the relay can no longer vouch for, and moves the revision.
            yield* client.next(
              (event) =>
                event.live && event.needsCount === null && event.revision > replayed.revision,
              "reset",
            );
            expect(relay.requests.map((request) => request.url)).toContain(
              "/relay/v1/capabilities",
            );
            // A capabilities change: the feed rereads them and sends the new state.
            relay.requests.length = 0;
            yield* control(fake, "/capabilities/bump", {});
            yield* client.next(
              (event) =>
                event.sectionsKnown &&
                relay.requests.some((request) => request.url === "/relay/v1/capabilities"),
              "state after capabilities.changed",
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
          const good = yield* service.today();
          const goodNeeds = yield* service.needs(undefined);
          yield* Effect.promise(() => relay.close());
          const away = yield* service.today();
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

describe("reshapeToday health", () => {
  const generatedAt = "2026-11-26T10:00:00Z";
  const reshape = (body: object) =>
    RelayFeed.reshapeToday({ generatedAt, ...body }, () => undefined)?.health;
  it("keeps the first 100 alarms from the relay", () => {
    const alarms = Array.from({ length: 101 }, (_, i) => ({
      id: String(i),
      sourceId: "monitor",
      severity: "info",
      title: "Notice",
      firedAt: generatedAt,
    }));
    expect(reshape({ health: { alarms } })?.alarms).toEqual(alarms.slice(0, 100));
  });

  it("retains check provenance and only active alarms", () => {
    const item = {
      id: "ping",
      source: "service",
      kind: "custom_metric",
      label: "Queue",
      state: "warning",
      observedAt: generatedAt,
    };
    const alarm = {
      id: "full",
      sourceId: "monitor",
      severity: "critical",
      title: "Queue full",
      firedAt: generatedAt,
    };
    expect(reshape({})).toBeUndefined();
    expect(
      reshape({
        health: {
          state: "ok",
          items: [item, { ...item, source: null }],
          alarms: [alarm, { ...alarm, resolvedAt: generatedAt }],
          notMeasured: [],
        },
      }),
    ).toEqual({ state: "ok", items: [item], alarms: [alarm], notMeasured: [] });
  });
});

describe("reshapeToday stuck subject", () => {
  const today = (item: unknown) =>
    RelayFeed.reshapeToday(
      { generatedAt: "2026-11-26T10:00:00Z", stuck: { state: "ok", items: [item] } },
      () => undefined,
    )?.stuck.items;
  const base = { rules: ["dev_red"], since: "2026-11-26T08:00:00Z" };
  const subject = {
    repo: "example-org/example-app",
    run: { name: "ci / test", url: "https://github.com/example-org/example-app/actions/runs/9" },
  };

  it("keeps a subject, with or without its run", () => {
    expect(today({ ...base, subject })).toEqual([{ ...base, subject }]);
    expect(today({ ...base, subject: { repo: "example-org/example-app" } })).toEqual([
      { ...base, subject: { repo: "example-org/example-app" } },
    ]);
  });

  it("keeps a job-only subject, with or without its url", () => {
    const job = { name: "nightly-backup", url: "https://jobs.example.com/nightly-backup" };
    expect(today({ ...base, subject: { job } })).toEqual([{ ...base, subject: { job } }]);
    expect(today({ ...base, subject: { job: { name: "nightly-backup" } } })).toEqual([
      { ...base, subject: { job: { name: "nightly-backup" } } },
    ]);
  });

  it("drops a subject without a repo or job, and a subject next to a task", () => {
    expect(today({ ...base, subject: { run: subject.run } })).toEqual([base]);
    const task = { id: "t_1", title: "Profile blocks" };
    expect(today({ ...base, task, subject })).toEqual([
      { ...base, task: { title: "Profile blocks" } },
    ]);
  });
});

describe("reshapeToday shipped", () => {
  const shipped = (item: unknown) =>
    RelayFeed.reshapeToday(
      { generatedAt: "2026-11-26T10:00:00Z", shipped: { state: "ok", items: [item] } },
      () => undefined,
    )?.shipped.items;
  const pr = {
    number: 41,
    url: "https://github.com/example-org/example-app/pull/41",
    repo: "example-org/example-app",
  };
  const ref = {
    tracker: "github",
    scope: "example-org/example-app",
    key: "37",
    url: "https://github.com/example-org/example-app/issues/37",
  };
  const base = {
    task: { id: "t_1", title: "Guild roster page" },
    summary: "Guild roster page merged.",
    mergedAt: "2026-11-26T07:00:00Z",
    live: "live",
  };
  const kept = {
    task: { title: "Guild roster page" },
    summary: base.summary,
    mergedAt: base.mergedAt,
    live: base.live,
  };

  it("keeps the item's own pull request and the task's ref", () => {
    expect(shipped({ ...base, pr, ref })).toEqual([{ ...kept, pr, ref }]);
    expect(shipped({ ...base, pr })).toEqual([{ ...kept, pr }]);
  });

  it("drops an item without a whole pull request, and a ref missing its url", () => {
    expect(shipped(base)).toEqual([]);
    expect(shipped({ ...base, pr: { number: 41, url: pr.url } })).toEqual([]);
    expect(shipped({ ...base, pr, ref: { ...ref, url: undefined } })).toEqual([{ ...kept, pr }]);
  });

  it.live("follows each joined relay on its own: two companies' data never mix", () =>
    withFake((fakeA, relayA) =>
      withFake((fakeB, relayB) =>
        onFreshHub(
          Effect.gen(function* () {
            const unknown = yield* subscribeTo(relayB.origin);
            yield* unknown.next((event) => !event.joined, "not joined before the join");
            const machineA = yield* join(fakeA, relayA);
            const machineB = yield* join(fakeB, relayB);
            yield* control(fakeA, "/needs", { machineId: machineA, count: 2, kind: "mention" });
            yield* control(fakeB, "/needs", {
              machineId: machineB,
              count: 3,
              kind: "thread_question",
            });
            const clientA = yield* subscribeTo(relayA.origin);
            yield* clientA.next(isLive, "A live");
            // A subscription opened before its relay was joined follows it once joined.
            yield* unknown.next(isLive, "B live");

            const service = yield* RelayFeed.BanneretRelayFeed;
            const kindsOf = (read: { readonly value: BanneretFeedTodayRead["value"] }) =>
              read.value?.needsYou.items.map((item) => item.kind);
            expect(kindsOf(yield* service.today(relayA.origin))).toEqual(["mention", "mention"]);
            expect(kindsOf(yield* service.today(relayB.origin))).toEqual([
              "thread_question",
              "thread_question",
              "thread_question",
            ]);
            relayA.requests.length = 0;
            yield* service.needs(relayB.origin, undefined);
            expect(
              relayA.requests.some((request) => request.url.startsWith("/relay/v1/needs")),
            ).toBe(false);

            // Leaving one company stops only its feed.
            const enrolment = yield* Enrolment.BanneretEnrolment;
            yield* enrolment.leave(relayA.origin, "revoke");
            yield* clientA.next((event) => !event.joined, "A not joined after leave");
            expect((yield* service.today(relayA.origin)).joined).toBe(false);
            expect((yield* service.today(relayB.origin)).joined).toBe(true);
            // A relay this machine never tried answers as not joined.
            expect((yield* service.today("https://unknown.example")).joined).toBe(false);
          }),
        ),
      ),
    ),
  );
});
