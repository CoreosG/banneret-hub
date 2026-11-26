// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimersInEffect:off globalJsonInEffect:off globalTimers:off globalFetch:off globalFetchInEffect:off - a real HTTP relay (the fake) behind a recording forwarder.
import * as NodeOS from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { FakeRelay, PersonInput } from "@t3tools/banneret-relay-fake";
import { type BanneretEnrolmentView, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import * as Workspaces from "../Workspaces.ts";
import * as Enrolment from "./Enrolment.ts";
import * as Facts from "./Facts.ts";
import { type Forwarder, type Recorded, withFake } from "./relayHarness.testkit.ts";

const FAST: Partial<Enrolment.EnrolmentOptions> = {
  pollFloorMs: 20,
  healthIntervalMs: 150,
  maxBackoffMs: 100,
  counterSaveMs: 0,
};
const ADA: PersonInput = { login: "ada-example", role: "founder" };

/** Machine facts only: these tests cover enrolment; Facts.test.ts covers what the heartbeat reports. */
const noActivity = Facts.layerFromInputs({
  environmentId: "env-test",
  workspaces: Effect.succeed([]),
  projects: Effect.succeed([]),
  threads: () => Effect.succeed([]),
  providers: Effect.succeed([]),
  policyFingerprint: Effect.succeed(null),
});

const environmentLayer = (environmentId: string) =>
  Layer.succeed(ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)),
  });

/** One server environment over `baseDir`; providing it again over the same directory is a restart. */
const hubLayer = (
  baseDir: string,
  options: Partial<Enrolment.EnrolmentOptions> = {},
  environmentId = "env-test-1",
) =>
  Enrolment.layerWith({ ...FAST, ...options }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(ServerSecretStore.layer, environmentLayer(environmentId), noActivity),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const makeBaseDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "banneret-enrol-" }));
}).pipe(Effect.provide(NodeServices.layer));

const onFreshHub =
  (options: Partial<Enrolment.EnrolmentOptions> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(makeBaseDir, (baseDir) => Effect.provide(effect, hubLayer(baseDir, options)));

const status = Effect.flatMap(Enrolment.BanneretEnrolment, (enrolment) => enrolment.status);

/** Resolves once `effect` yields a value `predicate` accepts, re-reading at each enrolment change. */
const waitFor = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  timeoutMs = 5000,
) =>
  Effect.gen(function* () {
    const enrolment = yield* Enrolment.BanneretEnrolment;
    let last: A | undefined;
    for (;;) {
      const changed = yield* enrolment.nextChange;
      last = yield* effect;
      if (predicate(last)) return last;
      yield* changed;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.die(new Error(`timed out waiting for ${predicate.toString()}`)),
    }),
  );

const waitForState = (state: BanneretEnrolmentView["state"], timeoutMs?: number) =>
  waitFor(status, (view) => view.state === state, timeoutMs);

const start = (origin: string, label = "Ada laptop") =>
  Effect.flatMap(Enrolment.BanneretEnrolment, (enrolment) =>
    enrolment.start({ origin, label, kind: "laptop" }),
  );

const secretsOnDisk = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const key = yield* secrets.get(Enrolment.KEY_SECRET);
  const token = yield* secrets.get(Enrolment.TOKEN_SECRET);
  return {
    key: Option.getOrUndefined(key),
    token: Option.map(token, (bytes) => Buffer.from(bytes).toString("utf8")).pipe(
      Option.getOrUndefined,
    ),
  };
});

const noSecretsLeft = waitFor(
  secretsOnDisk,
  (secrets) => secrets.key === undefined && secrets.token === undefined,
);

const stateFileText = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs
    .readFileString(path.join(config.stateDir, "banneret", "enrolment.json"))
    .pipe(Effect.orElseSucceed(() => ""));
});

const crashOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

const pairingId = Effect.map(stateFileText, (text) => JSON.parse(text).pairingId as string);

/** Enrols as `person` and waits for `configured`. */
const join = (fake: FakeRelay, relay: Forwarder, person: PersonInput = ADA, label?: string) =>
  Effect.gen(function* () {
    const view = yield* start(relay.origin, label);
    fake.approve(view.confirmCode!, person);
    return yield* waitForState("configured");
  });

/** Every request the forwarder sees for `windowMs`; spans more than two health intervals. */
const requestsDuring = (relay: Forwarder, windowMs = 500) =>
  Effect.gen(function* () {
    relay.requests.length = 0;
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- proving silence needs a window; no event marks "no request was sent".
    yield* Effect.sleep(windowMs);
    return [...relay.requests];
  });

describe("BanneretEnrolment", () => {
  it.live(
    "joins through confirmPairing, writes the workspace, and keeps every secret on the server",
    () =>
      withFake((fake, relay) =>
        Effect.gen(function* () {
          const logs: Array<Logger.Options<unknown>> = [];
          const baseDir = yield* makeBaseDir;
          yield* Effect.gen(function* () {
            const requested = yield* start(relay.origin);
            expect(requested.state).toBe("requested");
            expect(requested.displayName).toBe("Example Company");
            expect(requested.confirmCode).toMatch(/^[A-Z2-7]{8}$/);
            expect(new URL(requested.browserUrl!).origin).toBe(relay.origin);
            expect(requested.browserUrl).not.toContain(requested.confirmCode!);
            expect(requested.workspaceId).toMatch(/^ent-[0-9a-f]{16}$/);

            expect(fake.confirmPairing(yield* pairingId, requested.confirmCode!, ADA)).toBe(
              "approved",
            );
            const configured = yield* waitForState("configured");
            expect(configured.me).toEqual({ login: "ada-example", role: "founder" });
            expect(configured.label).toBe("Ada laptop");
            yield* waitFor(status, (view) => view.health === "healthy");

            const workspaces = (yield* Workspaces.list()).workspaces;
            expect(workspaces).toEqual([
              expect.objectContaining({
                id: requested.workspaceId,
                name: "Example Company",
                kind: "enterprise",
                relay: { origin: relay.origin, displayName: "Example Company" },
              }),
            ]);

            // The token and the key never leave the server: not in a reply, not in the state file.
            const { key, token } = yield* secretsOnDisk;
            expect(key).toBeDefined();
            expect(token).toBeDefined();
            const secretsAsText = [
              token!,
              Buffer.from(key!).toString("base64"),
              Buffer.from(key!).toString("hex"),
              Buffer.from(key!).toString("base64url"),
            ];
            const replies = JSON.stringify([requested, configured, yield* status]);
            const stateFile = yield* stateFileText;
            // The configured write keeps the counter mark the setup calls saved.
            expect(JSON.parse(stateFile).counterMark).toMatch(/^[1-9][0-9]{15,18}$/);
            for (const secret of secretsAsText) {
              expect(replies).not.toContain(secret);
              expect(stateFile).not.toContain(secret);
            }

            // No local path leaves the machine.
            const bodies = relay.requests
              .map((request) => `${request.url} ${request.body}`)
              .join("\n");
            expect(bodies).not.toContain(NodeOS.homedir());
            expect(bodies).not.toContain(process.cwd());
            expect(bodies).not.toContain(baseDir);
            // The code is never in a URL the Hub requests, nor in its logs.
            for (const request of relay.requests) {
              expect(request.url).not.toContain(requested.confirmCode!);
            }
            const logText = logs.map((entry) => Logger.formatLogFmt.log(entry)).join("\n");
            expect(logText).not.toContain(requested.confirmCode!);
            expect(logText).not.toContain(token!);
          }).pipe(
            Effect.provide(
              hubLayer(baseDir).pipe(
                Layer.provideMerge(
                  Logger.layer([Logger.make((entry) => logs.push(entry))], {
                    mergeWithExisting: false,
                  }),
                ),
              ),
            ),
          );
        }),
      ),
  );

  it.live("waits for a founder, then finishes", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const requested = yield* start(relay.origin);
        expect(
          fake.confirmPairing(yield* pairingId, requested.confirmCode!, {
            login: "new-person",
            awaitFounder: true,
          }),
        ).toBe("awaiting_approval");
        const awaiting = yield* waitForState("awaiting_approval");
        expect(Date.parse(awaiting.expiresAt!) - Date.parse(requested.expiresAt!)).toBeGreaterThan(
          6 * 86_400_000,
        );
        expect(fake.approvePairing(yield* pairingId)).toBe("approved");
        const configured = yield* waitForState("configured");
        expect(configured.me).toEqual({ login: "new-person", role: "limited_staff" });
      }).pipe(onFreshHub()),
    ),
  );

  it.live.each([
    ["declined", "refuse"],
    ["not_staff", "refuse"],
    ["code_expired", "expire"],
    ["approval_expired", "expire-awaiting"],
    ["too_many_attempts", "wrong-codes"],
  ] as const)("ends in none with reason %s and deletes the key", ([reason, how]) =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const requested = yield* start(relay.origin);
        const id = yield* pairingId;
        if (how === "refuse") fake.refusePairing(id, reason as "declined" | "not_staff");
        if (how === "expire") fake.expirePairing(id);
        if (how === "expire-awaiting") {
          fake.confirmPairing(id, requested.confirmCode!, {
            login: "newcomer",
            awaitFounder: true,
          });
          yield* waitForState("awaiting_approval");
          fake.expirePairing(id);
        }
        if (how === "wrong-codes") {
          for (let attempt = 0; attempt < 5; attempt += 1) fake.confirmPairing(id, "AAAAAAAA", ADA);
        }
        const none = yield* waitForState("none");
        expect(none.reason).toBe(reason);
        yield* noSecretsLeft;
      }).pipe(onFreshHub()),
    ),
  );

  it.live("cancels a request and refuses a second start while one is open", () =>
    withFake((_fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        yield* start(relay.origin);
        const second = yield* Effect.exit(start(relay.origin));
        expect(Exit.isFailure(second)).toBe(true);
        expect(JSON.stringify(second)).toContain("already joining or joined");
        const cancelled = yield* enrolment.cancel;
        expect(cancelled).toEqual({ state: "none", reason: "cancelled" });
        yield* noSecretsLeft;
      }).pipe(onFreshHub()),
    ),
  );

  it.live("a same-owner re-enrolment replaces the old machine, whose Hub lands in revoked", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const oldHub = yield* makeBaseDir;
        const newHub = yield* makeBaseDir;
        yield* join(fake, relay, ADA, "Old laptop").pipe(Effect.provide(hubLayer(oldHub)));
        // The same environment (a Hub that lost its files) joins again as the same person.
        const replaced = yield* join(fake, relay, ADA, "New laptop").pipe(
          Effect.provide(hubLayer(newHub)),
        );
        expect(replaced.replacedLabel).toBe("Old laptop");
        const revoked = yield* waitForState("revoked").pipe(Effect.provide(hubLayer(oldHub)));
        expect(revoked).toMatchObject({ reason: "removed", displayName: "Example Company" });
        expect(yield* secretsOnDisk.pipe(Effect.provide(hubLayer(oldHub)))).toEqual({
          key: undefined,
          token: undefined,
        });
      }),
    ),
  );

  it.live("a different owner of the same environment is refused with environment_enrolled", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        yield* join(fake, relay).pipe(onFreshHub());
        const none = yield* Effect.gen(function* () {
          const view = yield* start(relay.origin);
          fake.approve(view.confirmCode!, { login: "grace-example" });
          return yield* waitForState("none");
        }).pipe(onFreshHub());
        expect(none.reason).toBe("environment_enrolled");
      }),
    ),
  );

  it.live("says 'replaced' when token_revoked details carry that reason", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        yield* join(fake, relay);
        relay.intercept = (request) =>
          request.url === "/relay/v1/facts"
            ? {
                status: 401,
                body: JSON.stringify({
                  error: {
                    code: "token_revoked",
                    message: "Replaced.",
                    retryable: false,
                    details: { reason: "replaced" },
                  },
                }),
              }
            : undefined;
        expect((yield* waitForState("revoked")).reason).toBe("replaced");
      }).pipe(onFreshHub()),
    ),
  );

  it.live("removeStaff revokes the machine; afterwards the environment makes no relay call", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        yield* join(fake, relay);
        fake.removeStaff("ada-example");
        expect((yield* waitForState("revoked")).reason).toBe("removed");
        expect(yield* requestsDuring(relay)).toEqual([]);
      }).pipe(onFreshHub()),
    ),
  );

  it.live("goes unreachable while the relay is down and healthy again when it returns", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        yield* join(fake, relay);
        yield* Effect.promise(() => relay.close());
        const down = yield* waitFor(status, (view) => view.health === "unreachable");
        expect(down.unreachableSince).toBeDefined();
        yield* Effect.promise(() => relay.reopen());
        const up = yield* waitFor(status, (view) => view.health === "healthy");
        expect(up.unreachableSince).toBeUndefined();
      }).pipe(onFreshHub()),
    ),
  );

  it.live("resumes polling after a restart mid-request", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const baseDir = yield* makeBaseDir;
        const requested = yield* start(relay.origin).pipe(Effect.provide(hubLayer(baseDir)));
        fake.approve(requested.confirmCode!, ADA);
        const configured = yield* waitForState("configured").pipe(
          Effect.provide(hubLayer(baseDir)),
        );
        expect(configured.me?.login).toBe("ada-example");
      }),
    ),
  );

  it.live("leave revoke tells the relay, tombstones the workspace, then goes quiet", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        const joined = yield* join(fake, relay);
        const forget = yield* Effect.exit(enrolment.leave("forget"));
        expect(JSON.stringify(forget)).toContain("only while the relay cannot be reached");
        expect(yield* enrolment.leave("revoke")).toEqual({ state: "none", reason: "left" });
        expect(
          relay.requests.some(
            (request) =>
              request.method === "DELETE" &&
              request.url === `/relay/v1/machines/${joined.machineId}`,
          ),
        ).toBe(true);
        expect((yield* Workspaces.list()).workspaces).toEqual([
          expect.objectContaining({ id: joined.workspaceId, deleted: true }),
        ]);
        yield* noSecretsLeft;
        expect(yield* requestsDuring(relay)).toEqual([]);
      }).pipe(onFreshHub()),
    ),
  );

  it.live("leave forget works while the relay is unreachable, then goes quiet", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        yield* join(fake, relay);
        yield* Effect.promise(() => relay.close());
        yield* waitFor(status, (view) => view.health === "unreachable");
        expect(yield* enrolment.leave("forget")).toEqual({ state: "none", reason: "forgotten" });
        yield* Effect.promise(() => relay.reopen());
        expect(yield* requestsDuring(relay)).toEqual([]);
      }).pipe(onFreshHub()),
    ),
  );

  it.live("lists the person's machines and revokes another one", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const laptop = yield* makeBaseDir;
        const desktop = yield* makeBaseDir;
        yield* join(fake, relay, ADA, "Desktop").pipe(
          Effect.provide(hubLayer(desktop, {}, "env-desktop")),
        );
        yield* Effect.gen(function* () {
          const enrolment = yield* Enrolment.BanneretEnrolment;
          const joined = yield* join(fake, relay, ADA, "Laptop");
          const page = yield* enrolment.machines(undefined);
          expect(page.items.map((machine) => [machine.label, machine.thisMachine])).toEqual(
            expect.arrayContaining([
              ["Laptop", true],
              ["Desktop", false],
            ]),
          );
          const other = page.items.find((machine) => machine.label === "Desktop")!;
          const self = yield* Effect.exit(enrolment.revokeMachine(joined.machineId!));
          expect(JSON.stringify(self)).toContain("Use Leave");
          yield* enrolment.revokeMachine(other.id);
        }).pipe(Effect.provide(hubLayer(laptop)));
        const revoked = yield* waitForState("revoked").pipe(
          Effect.provide(hubLayer(desktop, {}, "env-desktop")),
        );
        expect(revoked.reason).toBe("removed");
      }),
    ),
  );

  it.live("an environment that never enrolled makes no relay call", () =>
    withFake((_fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        relay.requests.length = 0;
        expect(yield* enrolment.status).toEqual({ state: "none" });
        yield* Workspaces.put({
          workspaces: [
            {
              id: "solo",
              name: "Client work",
              kind: "solo",
              projectKeys: [],
              updatedAt: "2026-11-26T10:00:00.000Z",
            },
          ],
        });
        yield* Workspaces.list();
        expect(yield* requestsDuring(relay)).toEqual([]);
        expect(yield* enrolment.status).toEqual({ state: "none" });
      }).pipe(onFreshHub()),
    ),
  );

  it.live("accepts 300 concurrent signed calls", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        yield* join(fake, relay);
        const pages = yield* Effect.all(
          Array.from({ length: 300 }, () => enrolment.machines(undefined)),
          { concurrency: "unbounded" },
        );
        expect(pages).toHaveLength(300);
      }).pipe(onFreshHub({ counterSaveMs: 5000 })),
    ),
  );

  it.live("retries once with a fresh counter on counter_reused", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        yield* join(fake, relay);
        let refused = 0;
        relay.intercept = (request) => {
          if (!request.url.startsWith("/relay/v1/machines") || refused > 0) return undefined;
          refused += 1;
          return {
            status: 401,
            body: JSON.stringify({
              error: { code: "counter_reused", message: "Seen.", retryable: false },
            }),
          };
        };
        const before = relay.requests.length;
        yield* enrolment.machines(undefined);
        const counters = relay.requests
          .slice(before)
          .filter((request) => request.url.startsWith("/relay/v1/machines"))
          .map((request) => request.headers["x-banneret-counter"]);
        expect(counters).toHaveLength(2);
        expect(BigInt(counters[1] as string)).toBeGreaterThan(BigInt(counters[0] as string));
      }).pipe(onFreshHub()),
    ),
  );

  it.live("matches local git remotes against the relay's repository list", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        yield* join(fake, relay);
        fake.seedRepositories(3);
        const matched = yield* enrolment.matchProjects([
          "git@github.com:Example-Org/repo-2.git",
          "https://github.com/example-org/repo-9",
          "https://github.com/other-org/repo-1",
          "/home/someone/src/repo-1",
        ]);
        expect(matched).toEqual(["git@github.com:Example-Org/repo-2.git"]);
        const sent = relay.requests.map((request) => `${request.url} ${request.body}`).join("\n");
        expect(sent).not.toContain("repo-2.git");
        expect(sent).not.toContain("/home/someone");
      }).pipe(onFreshHub()),
    ),
  );

  it.live("refuses a relay that redirects, and a sign-in page on another origin", () =>
    withFake((_fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        relay.intercept = (request) =>
          request.url === "/relay/v1/capabilities"
            ? { status: 302, headers: { location: "https://elsewhere.example/" } }
            : undefined;
        const redirected = yield* Effect.exit(enrolment.probe(relay.origin));
        expect(JSON.stringify(redirected)).toContain("redirects");
        expect(relay.requests.filter((request) => request.url === "/")).toEqual([]);

        relay.intercept = undefined;
        relay.rewrite = (request, body) =>
          request.url === "/relay/v1/enroll/start"
            ? JSON.stringify({ ...JSON.parse(body), browserUrl: "https://phish.example/enroll" })
            : body;
        const foreign = yield* Effect.exit(start(relay.origin));
        expect(JSON.stringify(foreign)).toContain("another address");
        expect(yield* status).toEqual({ state: "none" });
        yield* noSecretsLeft;
      }).pipe(onFreshHub()),
    ),
  );

  it.live("reports a wrong clock and makes no signed call when a saved counter is far ahead", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const baseDir = yield* makeBaseDir;
        const joined = yield* join(fake, relay).pipe(Effect.provide(hubLayer(baseDir)));
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const file = `${config.stateDir}/banneret/enrolment.json`;
          const saved = JSON.parse(yield* fs.readFileString(file));
          saved.counterMark = String(BigInt(Date.parse(joined.lastOkAt!) + 10 * 60_000) * 1000n);
          yield* fs.writeFileString(file, JSON.stringify(saved));
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), baseDir).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          relay.requests.length = 0;
          const view = yield* waitFor(status, (current) => current.health === "clock_wrong");
          expect(view.state).toBe("configured");
          expect(yield* requestsDuring(relay)).toEqual([]);
        }).pipe(Effect.provide(hubLayer(baseDir)));
      }),
    ),
  );

  it.live.each([
    ["an answer without me", 200, "{}", "invalid_reply", "cancel"],
    ["a relay that is down", 503, "", "unreachable", "forget"],
    [
      "a 401 that is not token_revoked",
      401,
      JSON.stringify({ error: { code: "unknown_device", message: "No.", retryable: false } }),
      "refused",
      "forget",
    ],
    [
      "a 403",
      403,
      JSON.stringify({ error: { code: "forbidden", message: "No.", retryable: false } }),
      "forbidden",
      "cancel",
    ],
  ] as const)("approved with %s shows its health and can be left", ([, code, body, health, exit]) =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        // Only signed setup calls: the anonymous probe inside start still reaches the fake.
        relay.intercept = (request) =>
          request.url.startsWith("/relay/v1/capabilities") &&
          request.headers["x-banneret-device"] !== undefined
            ? { status: code, body }
            : undefined;
        const view = yield* start(relay.origin);
        fake.approve(view.confirmCode!, ADA);
        const stuck = yield* waitFor(
          status,
          (current) => current.state === "approved" && current.health === health,
        );
        expect(stuck.machineId).toBeDefined();
        const left = exit === "cancel" ? yield* enrolment.cancel : yield* enrolment.leave("forget");
        expect(left).toEqual({ state: "none", reason: "forgotten" });
        yield* noSecretsLeft;
        relay.intercept = undefined;
        expect(yield* requestsDuring(relay)).toEqual([]);
      }).pipe(onFreshHub()),
    ),
  );

  it.live("approved stays out of signed RPCs and finishes once the relay answers", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        let release = false;
        relay.intercept = (request) =>
          !release &&
          request.url.startsWith("/relay/v1/capabilities") &&
          request.headers["x-banneret-device"] !== undefined
            ? { status: 503 }
            : undefined;
        const view = yield* start(relay.origin);
        fake.approve(view.confirmCode!, ADA);
        yield* waitForState("approved");
        const machinesCall = yield* Effect.exit(enrolment.machines(undefined));
        expect(JSON.stringify(machinesCall)).toContain("has not joined");
        release = true;
        yield* waitForState("configured");
      }).pipe(onFreshHub()),
    ),
  );

  it.live.each([
    ["0", (polls: number) => expect(polls).toBeLessThanOrEqual(30)],
    ["99999999999", (polls: number) => expect(polls).toBeGreaterThanOrEqual(2)],
  ] as const)("clamps Retry-After %s to the poll floor and the backoff cap", ([after, check]) =>
    withFake((_fake, relay) =>
      Effect.gen(function* () {
        relay.intercept = (request) =>
          request.url === "/relay/v1/enroll/poll"
            ? {
                status: 503,
                headers: { "retry-after": after },
                body: JSON.stringify({
                  error: { code: "unavailable", message: "Busy.", retryable: true },
                }),
              }
            : undefined;
        yield* start(relay.origin);
        const seen = yield* requestsDuring(relay, 600);
        // pollFloorMs 20 allows 30 polls in 600 ms; maxBackoffMs 100 forces at least a few.
        check(seen.filter((request) => request.url === "/relay/v1/enroll/poll").length);
        expect((yield* status).state).toBe("requested");
      }).pipe(onFreshHub()),
    ),
  );

  it.live.each([
    ["in the query", (url: string, code: string) => `${url}&code=${code}`],
    ["in lower case", (url: string, code: string) => `${url}&c=${code.toLowerCase()}`],
    [
      "percent-encoded",
      (url: string, code: string) => `${url}&c=%${code.charCodeAt(0).toString(16)}${code.slice(1)}`,
    ],
  ] as const)("refuses a sign-in link that carries the code %s", ([, carry]) =>
    withFake((_fake, relay) =>
      Effect.gen(function* () {
        relay.rewrite = (request, body) => {
          if (request.url !== "/relay/v1/enroll/start") return body;
          const reply = JSON.parse(body);
          return JSON.stringify({
            ...reply,
            browserUrl: carry(reply.browserUrl, reply.confirmCode),
          });
        };
        const refused = yield* Effect.exit(start(relay.origin));
        expect(JSON.stringify(refused)).toContain("put the code in its sign-in link");
        expect(yield* status).toEqual({ state: "none" });
        yield* noSecretsLeft;
      }).pipe(onFreshHub()),
    ),
  );

  it.live("a failed join again after a 401 keeps the working key, token and state", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const baseDir = yield* makeBaseDir;
        let crashAt: string | undefined;
        const beforeWrite = (step: string) =>
          Effect.suspend(() =>
            step === crashAt ? Effect.die(new Error(`crash at ${step}`)) : Effect.void,
          );
        const hub = hubLayer(baseDir, { beforeWrite });
        const refuseSigned = (request: Recorded) =>
          (request.url.startsWith("/relay/v1/capabilities") || request.url === "/relay/v1/facts") &&
          request.headers["x-banneret-device"] !== undefined
            ? {
                status: 401,
                body: JSON.stringify({
                  error: { code: "unknown_device", message: "No.", retryable: false },
                }),
              }
            : undefined;
        const allSecrets = Effect.gen(function* () {
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          return {
            ...(yield* secretsOnDisk),
            next: Option.getOrUndefined(yield* secrets.get(Enrolment.NEXT_KEY_SECRET)),
          };
        });

        const working = yield* Effect.gen(function* () {
          yield* join(fake, relay);
          relay.intercept = refuseSigned;
          yield* waitFor(status, (view) => view.health === "refused");
          return yield* allSecrets;
        }).pipe(Effect.provide(hub));
        expect(working.next).toBeUndefined();

        // Each provide below is a restart, and health is run-time: wait for the 401 again.
        const refusedAgain = waitFor(status, (view) => view.health === "refused");
        const unchanged = Effect.gen(function* () {
          const view = yield* status;
          expect(view.state).toBe("configured");
          expect(yield* allSecrets).toEqual(working);
        });

        // enroll/start fails.
        relay.intercept = (request) =>
          request.url === "/relay/v1/enroll/start" ? { status: 503 } : refuseSigned(request);
        yield* Effect.gen(function* () {
          yield* refusedAgain;
          const failed = yield* Effect.exit(start(relay.origin));
          expect(JSON.stringify(failed)).toContain("unavailable");
          yield* unchanged;
        }).pipe(Effect.provide(hub));

        // The relay's sign-in page is on another origin.
        relay.intercept = refuseSigned;
        relay.rewrite = (request, body) =>
          request.url === "/relay/v1/enroll/start"
            ? JSON.stringify({ ...JSON.parse(body), browserUrl: "https://phish.example/enroll" })
            : body;
        yield* Effect.gen(function* () {
          yield* refusedAgain;
          const failed = yield* Effect.exit(start(relay.origin));
          expect(JSON.stringify(failed)).toContain("another address");
          yield* unchanged;
        }).pipe(Effect.provide(hub));
        relay.rewrite = undefined;

        // A crash at any write before `requested` is saved, then a restart: nothing changed.
        for (const step of [`set:${Enrolment.NEXT_KEY_SECRET}`, "state:requested"]) {
          crashAt = step;
          const crashed = yield* Effect.gen(function* () {
            yield* refusedAgain;
            return yield* Effect.exit(start(relay.origin));
          }).pipe(Effect.provide(hub));
          expect(crashOf(crashed)).toContain(`crash at ${step}`);
          crashAt = undefined;
          yield* unchanged.pipe(Effect.provide(hub));
        }

        // A crash at any write after `requested` is saved: the restart keeps the new pairing, with
        // the new key in place and the old token gone, and the join completes.
        for (const step of [
          `set:${Enrolment.KEY_SECRET}`,
          `remove:${Enrolment.NEXT_KEY_SECRET}`,
          `remove:${Enrolment.TOKEN_SECRET}`,
        ]) {
          relay.intercept = refuseSigned;
          const { before, crashed } = yield* Effect.gen(function* () {
            yield* refusedAgain;
            const before = yield* allSecrets;
            crashAt = step;
            return { before, crashed: yield* Effect.exit(start(relay.origin)) };
          }).pipe(Effect.provide(hub));
          expect(crashOf(crashed)).toContain(`crash at ${step}`);
          crashAt = undefined;
          relay.intercept = undefined;
          yield* Effect.gen(function* () {
            const resumed = yield* status;
            expect(resumed.state).toBe("requested");
            const secrets = yield* allSecrets;
            expect(secrets.next).toBeUndefined();
            expect(secrets.token).toBeUndefined();
            expect(Buffer.from(secrets.key!).equals(Buffer.from(before.key!))).toBe(false);
            fake.approve(resumed.confirmCode!, ADA);
            yield* waitForState("configured");
            yield* waitFor(status, (view) => view.health === "healthy");
          }).pipe(Effect.provide(hub));
        }
      }),
    ),
  );

  it.live("leaves a state from the table after a crash at any write", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        // Long intervals keep the write sequence fixed: no health checks or counter saves between.
        const quiet = { healthIntervalMs: 60_000, counterSaveMs: 60_000 };
        const joinAndLeave = Effect.gen(function* () {
          const started = yield* Effect.exit(start(relay.origin));
          if (Exit.isSuccess(started)) fake.approve(started.value.confirmCode!, ADA);
          yield* Effect.exit(waitForState("configured", 2000));
          const enrolment = yield* Enrolment.BanneretEnrolment;
          yield* Effect.exit(enrolment.leave("revoke"));
        });

        const steps: string[] = [];
        yield* joinAndLeave.pipe(
          onFreshHub({ ...quiet, beforeWrite: (step) => Effect.sync(() => steps.push(step)) }),
        );
        expect(steps).toEqual([
          "set:banneret-relay-key",
          "state:requested",
          "set:banneret-relay-token",
          "state:approved",
          "state:approved",
          "workspace",
          "state:configured",
          "state:none",
          "remove:banneret-relay-key",
          "remove:banneret-relay-token",
          "workspace",
        ]);

        for (let failAt = 1; failAt <= steps.length; failAt += 1) {
          const baseDir = yield* makeBaseDir;
          const environmentId = `env-kill-${failAt}`;
          let writes = 0;
          const beforeWrite = (step: string) =>
            Effect.suspend(() => {
              writes += 1;
              return writes >= failAt ? Effect.die(new Error(`crash at ${step}`)) : Effect.void;
            });
          yield* joinAndLeave.pipe(
            Effect.provide(hubLayer(baseDir, { ...quiet, beforeWrite }, environmentId)),
          );

          // Restart without the fault: it settles in a final state whose secrets agree with it.
          yield* Effect.gen(function* () {
            const settled = yield* waitFor(
              Effect.all({ view: status, secrets: secretsOnDisk }),
              ({ view, secrets }) =>
                view.state === "configured"
                  ? secrets.key !== undefined && secrets.token !== undefined
                  : (view.state === "none" || view.state === "revoked") &&
                    secrets.key === undefined &&
                    secrets.token === undefined,
              3000,
            );
            expect(["none", "configured", "revoked"]).toContain(settled.view.state);
          }).pipe(Effect.provide(hubLayer(baseDir, {}, environmentId)));
        }
      }),
    ),
  );
});
