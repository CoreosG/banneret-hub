// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimersInEffect:off globalJsonInEffect:off globalTimers:off globalFetch:off globalFetchInEffect:off - a real HTTP relay (the fake) behind a recording forwarder.
import * as NodeOS from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type FakeRelay,
  keyFromSeed,
  type PersonInput,
  RelayClient,
} from "@t3tools/banneret-relay-fake";
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
import { focus, type Forwarder, type Recorded, withFake } from "./relayHarness.testkit.ts";

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

const statusOf = (origin: string) =>
  Effect.flatMap(Enrolment.BanneretEnrolment, (enrolment) => enrolment.status(origin));
const status = Effect.suspend(() => statusOf(focus.origin));

/** A `none` view of `origin` with the given last result. */
const noneOf = (
  extra: { readonly reason?: string; readonly message?: string } = {},
  origin = focus.origin,
): BanneretEnrolmentView => ({
  state: "none",
  workspaceId: `ent-${Enrolment.relayHash(origin)}`,
  relayOrigin: origin,
  ...extra,
});

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

const secretsOf = (origin: string) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const key = yield* secrets.get(Enrolment.keySecret(origin));
    const token = yield* secrets.get(Enrolment.tokenSecret(origin));
    return {
      key: Option.getOrUndefined(key),
      token: Option.map(token, (bytes) => Buffer.from(bytes).toString("utf8")).pipe(
        Option.getOrUndefined,
      ),
    };
  });

const secretsOnDisk = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const key = yield* secrets.get(Enrolment.keySecret(focus.origin));
  const token = yield* secrets.get(Enrolment.tokenSecret(focus.origin));
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

const stateFileOf = (origin: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs
      .readFileString(
        path.join(config.stateDir, "banneret", "relays", `${Enrolment.relayHash(origin)}.json`),
      )
      .pipe(Effect.orElseSucceed(() => ""));
  });
const stateFileText = Effect.suspend(() => stateFileOf(focus.origin));

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
            // Support matches the join to the relay's `pairings list` by these.
            expect(requested.pairingId).toBe(yield* pairingId);
            const machine = yield* Effect.flatMap(
              Enrolment.BanneretEnrolment,
              (enrolment) => enrolment.machine,
            );
            expect(machine.environmentId).not.toBe("");
            expect(machine.hostname).toMatch(/^[A-Za-z0-9]/);

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
        expect(JSON.stringify(second)).toContain("already joining or has joined");
        const cancelled = yield* enrolment.cancel(focus.origin);
        expect(cancelled).toEqual(noneOf({ reason: "cancelled" }));
        yield* noSecretsLeft;
      }).pipe(onFreshHub()),
    ),
  );

  it.live("a new start clears the last result, even when that start fails", () =>
    withFake((_fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        yield* start(relay.origin);
        yield* enrolment.cancel(focus.origin);
        expect(yield* status).toEqual(noneOf({ reason: "cancelled" }));

        // The relay is down: the start fails, and the old "cancelled" is gone all the same.
        relay.intercept = (request) =>
          request.url === "/relay/v1/enroll/start" ? { status: 503 } : undefined;
        const failed = yield* Effect.exit(start(relay.origin));
        expect(JSON.stringify(failed)).toContain("unavailable");
        expect(yield* status).toEqual(noneOf());
        expect(JSON.parse(yield* stateFileText)).toEqual({
          state: "none",
          relayOrigin: relay.origin,
        });

        relay.intercept = undefined;
        const requested = yield* start(relay.origin);
        expect(requested.state).toBe("requested");
        expect(requested.reason).toBeUndefined();
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
        const forget = yield* Effect.exit(enrolment.leave(focus.origin, "forget"));
        expect(JSON.stringify(forget)).toContain("only while the relay cannot be reached");
        expect(yield* enrolment.leave(focus.origin, "revoke")).toEqual(noneOf({ reason: "left" }));
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

  it.live("leaves the machine and preserves a workspace shared with another joined machine", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        const joined = yield* join(fake, relay);
        const before = yield* Workspaces.list();
        expect(before.workspaces.map((entry) => entry.id)).toContain(joined.workspaceId);
        expect(yield* enrolment.leave(relay.origin, "revoke", true)).toEqual(
          noneOf({ reason: "left" }),
        );
        expect(yield* Workspaces.list()).toEqual(before);
        yield* noSecretsLeft;
      }).pipe(onFreshHub()),
    ),
  );

  it.live("a relay that no longer knows the machine is not reported as leaving", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        const joined = yield* join(fake, relay);
        // A wiped relay store: every signed call meets an unknown token.
        relay.intercept = (request) =>
          request.headers["x-banneret-device"] !== undefined
            ? {
                status: 401,
                body: JSON.stringify({
                  error: { code: "unauthenticated", message: "Unknown token.", retryable: false },
                }),
              }
            : undefined;
        const view = yield* waitFor(status, (current) => current.health === "unknown_machine");
        expect(view.state).toBe("configured");
        expect(yield* enrolment.leave(focus.origin, "revoke")).toEqual(
          noneOf({
            reason: "unknown_machine",
            message: `${joined.displayName} no longer knows this machine (the relay may have been reset). Join again.`,
          }),
        );
        relay.intercept = undefined;
        yield* noSecretsLeft;
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
        expect(yield* enrolment.leave(focus.origin, "forget")).toEqual(
          noneOf({ reason: "forgotten" }),
        );
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
          const page = yield* enrolment.machines(focus.origin, undefined);
          expect(page.items.map((machine) => [machine.label, machine.thisMachine])).toEqual(
            expect.arrayContaining([
              ["Laptop", true],
              ["Desktop", false],
            ]),
          );
          const other = page.items.find((machine) => machine.label === "Desktop")!;
          const self = yield* Effect.exit(enrolment.revokeMachine(focus.origin, joined.machineId!));
          expect(JSON.stringify(self)).toContain("Use Leave");
          yield* enrolment.revokeMachine(focus.origin, other.id);
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
        expect(yield* enrolment.status(focus.origin)).toEqual(noneOf());
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
        expect(yield* enrolment.status(focus.origin)).toEqual(noneOf());
        expect(yield* enrolment.list).toEqual([]);
      }).pipe(onFreshHub()),
    ),
  );

  it.live("accepts 300 concurrent signed calls", () =>
    withFake((fake, relay) =>
      Effect.gen(function* () {
        const enrolment = yield* Enrolment.BanneretEnrolment;
        yield* join(fake, relay);
        const pages = yield* Effect.all(
          Array.from({ length: 300 }, () => enrolment.machines(focus.origin, undefined)),
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
        yield* enrolment.machines(focus.origin, undefined);
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
        const matched = yield* enrolment.matchProjects(focus.origin, [
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
        expect(yield* status).toEqual(noneOf());
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
          const file = `${config.stateDir}/banneret/relays/${Enrolment.relayHash(relay.origin)}.json`;
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
        const left =
          exit === "cancel"
            ? yield* enrolment.cancel(focus.origin)
            : yield* enrolment.leave(focus.origin, "forget");
        expect(left).toEqual(noneOf({ reason: "forgotten" }));
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
        const machinesCall = yield* Effect.exit(enrolment.machines(focus.origin, undefined));
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
        expect(yield* status).toEqual(noneOf());
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
            next: Option.getOrUndefined(yield* secrets.get(Enrolment.nextKeySecret(focus.origin))),
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
        for (const step of [`set:${Enrolment.nextKeySecret(focus.origin)}`, "state:requested"]) {
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
          `set:${Enrolment.keySecret(focus.origin)}`,
          `remove:${Enrolment.nextKeySecret(focus.origin)}`,
          `remove:${Enrolment.tokenSecret(focus.origin)}`,
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

  describe("token re-issue", () => {
    const tokenOf = (body: string) => (JSON.parse(body) as { token?: string }).token;

    it.live("re-polls for a fresh token after a crash between receiving and saving it", () =>
      withFake((fake, relay) =>
        Effect.gen(function* () {
          const baseDir = yield* makeBaseDir;
          let reached: () => void = () => undefined;
          const crashed = new Promise<void>((resolve) => {
            reached = resolve;
          });
          // The token is written; the `approved` state write never lands.
          const beforeWrite = (step: string) =>
            Effect.suspend(() => {
              if (step !== "state:approved") return Effect.void;
              reached();
              return Effect.die(new Error(`crash at ${step}`));
            });
          const lostToken = yield* Effect.gen(function* () {
            const requested = yield* start(relay.origin);
            fake.approve(requested.confirmCode!, ADA);
            yield* Effect.promise(() => crashed);
            return (yield* secretsOnDisk).token;
          }).pipe(Effect.provide(hubLayer(baseDir, { beforeWrite })));
          expect(lostToken).toBeDefined();

          // Restart: still `requested`, the unsaved token is dropped, and the next poll brings a fresh one.
          relay.requests.length = 0;
          yield* Effect.gen(function* () {
            yield* waitForState("configured");
            const { token } = yield* secretsOnDisk;
            expect(token).toBeDefined();
            expect(token).not.toBe(lostToken);
            const polls = relay.requests.filter(
              (request) => request.url === "/relay/v1/enroll/poll",
            );
            expect(polls.length).toBeGreaterThan(0);
            expect(JSON.parse(yield* stateFileText).pairingId).toBeUndefined();
          }).pipe(Effect.provide(hubLayer(baseDir)));
        }),
      ),
    );

    it.live("recovers when the poll reply that carried the token is lost", () =>
      withFake((fake, relay) =>
        Effect.gen(function* () {
          const dropped: string[] = [];
          relay.drop = (request, body) => {
            if (request.url !== "/relay/v1/enroll/poll" || dropped.length > 0) return false;
            const token = tokenOf(body);
            if (token === undefined) return false;
            dropped.push(token);
            return true;
          };
          const requested = yield* start(relay.origin);
          fake.approve(requested.confirmCode!, ADA);
          yield* waitForState("configured");
          yield* waitFor(status, (view) => view.health === "healthy");
          expect(dropped).toHaveLength(1);
          const { token } = yield* secretsOnDisk;
          expect(token).toBeDefined();
          expect(token).not.toBe(dropped[0]);
        }).pipe(onFreshHub()),
      ),
    );

    it.live("polls again when an older token is refused as unauthenticated", () =>
      withFake((fake, relay) =>
        Effect.gen(function* () {
          // Hold the Hub in `approved`: every signed call answers 503.
          relay.intercept = (request) =>
            request.headers["x-banneret-device"] !== undefined ? { status: 503 } : undefined;
          const requested = yield* start(relay.origin);
          fake.approve(requested.confirmCode!, ADA);
          yield* waitForState("approved");
          const held = yield* secretsOnDisk;
          const id = yield* pairingId;

          // Someone else polls the pairing with this machine's key: the Hub's token is now an older one.
          const reply = yield* Effect.promise(() =>
            new RelayClient(fake.url).send(
              keyFromSeed(held.key!),
              "POST",
              "/relay/v1/enroll/poll",
              {
                body: { pairingId: id },
              },
            ),
          );
          const replacing = (reply.body as { token?: string }).token;
          expect(replacing).toBeDefined();
          expect(replacing).not.toBe(held.token);

          relay.requests.length = 0;
          relay.intercept = undefined;
          yield* waitForState("configured");
          const refusedAt = relay.requests.findIndex(
            (request) => request.url === "/relay/v1/capabilities" && request.status === 401,
          );
          expect(refusedAt).toBeGreaterThanOrEqual(0);
          const pollAt = relay.requests.findIndex(
            (request, index) => index > refusedAt && request.url === "/relay/v1/enroll/poll",
          );
          expect(pollAt).toBeGreaterThan(refusedAt);
          const { token } = yield* secretsOnDisk;
          expect([held.token, replacing]).not.toContain(token);
        }).pipe(onFreshHub()),
      ),
    );
  });

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
          yield* Effect.exit(enrolment.leave(focus.origin, "revoke"));
        });

        const steps: string[] = [];
        yield* joinAndLeave.pipe(
          onFreshHub({ ...quiet, beforeWrite: (step) => Effect.sync(() => steps.push(step)) }),
        );
        const hash = Enrolment.relayHash(relay.origin);
        expect(steps).toEqual([
          "state:none",
          `set:banneret-relay-key-${hash}`,
          "state:requested",
          `set:banneret-relay-token-${hash}`,
          "state:approved",
          "state:approved",
          "workspace",
          "state:configured",
          "state:none",
          `remove:banneret-relay-key-${hash}`,
          `remove:banneret-relay-token-${hash}`,
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

  describe("two relays on one environment", () => {
    /** Enrols with `relay` and waits for its `configured`. */
    const joinRelay = (fake: FakeRelay, relay: Forwarder, label = "Ada laptop") =>
      Effect.gen(function* () {
        const view = yield* start(relay.origin, label);
        fake.approve(view.confirmCode!, ADA);
        return yield* waitFor(statusOf(relay.origin), (current) => current.state === "configured");
      });

    it.live(
      "joins both, each with its own state, secrets and workspace; Leave on one keeps the other",
      () =>
        withFake((fakeA, relayA) =>
          withFake((fakeB, relayB) =>
            Effect.gen(function* () {
              const baseDir = yield* makeBaseDir;
              const [a, b] = yield* Effect.gen(function* () {
                const enrolment = yield* Enrolment.BanneretEnrolment;
                const a = yield* joinRelay(fakeA, relayA);
                // The first relay is joined, and a second one still starts at its own address.
                const b = yield* joinRelay(fakeB, relayB);
                expect(a.workspaceId).not.toBe(b.workspaceId);
                expect(
                  (yield* enrolment.list).map((view) => [view.relayOrigin, view.state]),
                ).toEqual(
                  [
                    [relayA.origin, "configured"],
                    [relayB.origin, "configured"],
                  ].toSorted(([x], [y]) => x!.localeCompare(y!)),
                );
                // The same relay again is refused: one enrolment per relay.
                const again = yield* Effect.exit(start(relayA.origin));
                expect(JSON.stringify(again)).toContain("already joining or has joined");

                const secretsA = yield* secretsOf(relayA.origin);
                const secretsB = yield* secretsOf(relayB.origin);
                expect(secretsA.token).toBeDefined();
                expect(secretsB.token).toBeDefined();
                expect(secretsA.token).not.toBe(secretsB.token);
                expect(Buffer.from(secretsA.key!).equals(Buffer.from(secretsB.key!))).toBe(false);
                const ids = (yield* Workspaces.list()).workspaces.map((workspace) => workspace.id);
                expect(ids.toSorted()).toEqual([a.workspaceId, b.workspaceId].toSorted());

                // Per-relay calls reach only their relay.
                relayA.requests.length = 0;
                relayB.requests.length = 0;
                const machinesB = yield* enrolment.machines(relayB.origin, undefined);
                expect(machinesB.items.find((machine) => machine.thisMachine)?.id).toBe(
                  b.machineId,
                );
                expect(
                  relayB.requests.some((request) => request.url.startsWith("/relay/v1/machines")),
                ).toBe(true);
                expect(
                  relayA.requests.some((request) => request.url.startsWith("/relay/v1/machines")),
                ).toBe(false);

                expect(yield* enrolment.leave(relayA.origin, "revoke")).toEqual(
                  noneOf({ reason: "left" }, relayA.origin),
                );
                expect(yield* secretsOf(relayA.origin)).toEqual({
                  key: undefined,
                  token: undefined,
                });
                expect((yield* secretsOf(relayB.origin)).token).toBe(secretsB.token);
                expect((yield* statusOf(relayB.origin)).state).toBe("configured");
                const workspaces = (yield* Workspaces.list()).workspaces;
                expect(
                  workspaces.find((workspace) => workspace.id === a.workspaceId)?.deleted,
                ).toBe(true);
                expect(
                  workspaces.find((workspace) => workspace.id === b.workspaceId)?.deleted,
                ).toBeUndefined();
                // The relay left hears nothing more; the other keeps its heartbeat.
                const quietA = yield* requestsDuring(relayA);
                expect(quietA).toEqual([]);
                expect(relayB.requests.some((request) => request.url === "/relay/v1/facts")).toBe(
                  true,
                );
                return [a, b] as const;
              }).pipe(Effect.provide(hubLayer(baseDir)));

              // A restart loads both relays from their own files.
              yield* Effect.gen(function* () {
                expect((yield* statusOf(relayA.origin)).state).toBe("none");
                const resumed = yield* waitFor(
                  statusOf(relayB.origin),
                  (view) => view.health === "healthy",
                );
                expect(resumed.machineId).toBe(b.machineId);
                expect(a.machineId).not.toBe(b.machineId);
              }).pipe(Effect.provide(hubLayer(baseDir)));
            }),
          ),
        ),
    );

    it.live("a crash at any write of one relay leaves the other relay untouched", () =>
      withFake((fakeA, relayA) =>
        withFake((fakeB, relayB) =>
          Effect.gen(function* () {
            const quiet = { healthIntervalMs: 60_000, counterSaveMs: 60_000 };
            const hashB = Enrolment.relayHash(relayB.origin);
            const joinAndLeaveB = Effect.gen(function* () {
              const started = yield* Effect.exit(start(relayB.origin));
              if (Exit.isSuccess(started)) fakeB.approve(started.value.confirmCode!, ADA);
              yield* Effect.exit(
                waitFor(statusOf(relayB.origin), (view) => view.state === "configured", 2000),
              );
              const enrolment = yield* Enrolment.BanneretEnrolment;
              yield* Effect.exit(enrolment.leave(relayB.origin, "revoke"));
            });

            // Relay B's writes: everything with its hash, and the workspace writes while armed.
            const countsFor = (step: string) =>
              step.includes(hashB) || step === "workspace" || step.startsWith("state:");
            for (let failAt = 1; failAt <= 12; failAt += 1) {
              const baseDir = yield* makeBaseDir;
              const environmentId = `env-two-${failAt}`;
              let armed = false;
              let writes = 0;
              const beforeWrite = (step: string) =>
                Effect.suspend(() => {
                  if (!armed || !countsFor(step)) return Effect.void;
                  writes += 1;
                  return writes >= failAt ? Effect.die(new Error(`crash at ${step}`)) : Effect.void;
                });
              const before = yield* Effect.gen(function* () {
                const joined = yield* joinRelay(fakeA, relayA);
                const files = {
                  state: yield* stateFileOf(relayA.origin),
                  secrets: yield* secretsOf(relayA.origin),
                };
                armed = true;
                yield* joinAndLeaveB;
                return { joined, files };
              }).pipe(Effect.provide(hubLayer(baseDir, { ...quiet, beforeWrite }, environmentId)));

              yield* Effect.gen(function* () {
                // Relay B settles in a state of the table, with secrets that agree with it.
                const settled = yield* waitFor(
                  Effect.all({ view: statusOf(relayB.origin), secrets: secretsOf(relayB.origin) }),
                  ({ view, secrets }) =>
                    view.state === "configured"
                      ? secrets.key !== undefined && secrets.token !== undefined
                      : (view.state === "none" || view.state === "revoked") &&
                        secrets.key === undefined &&
                        secrets.token === undefined,
                  3000,
                );
                expect(["none", "configured", "revoked"]).toContain(settled.view.state);
                // Relay A's files are the ones it had before B started, and it is still joined.
                expect(yield* secretsOf(relayA.origin)).toEqual(before.files.secrets);
                const stateA = JSON.parse(yield* stateFileOf(relayA.origin));
                const savedA = JSON.parse(before.files.state);
                expect({ ...stateA, lastOkAt: undefined, counterMark: undefined }).toEqual({
                  ...savedA,
                  lastOkAt: undefined,
                  counterMark: undefined,
                });
                const viewA = yield* statusOf(relayA.origin);
                expect(viewA.state).toBe("configured");
                expect(viewA.machineId).toBe(before.joined.machineId);
              }).pipe(Effect.provide(hubLayer(baseDir, quiet, environmentId)));
            }
          }),
        ),
      ),
    );
  });
});
