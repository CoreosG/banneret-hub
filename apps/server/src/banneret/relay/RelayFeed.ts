// @effect-diagnostics globalFetch:off globalFetchInEffect:off - the relay's event stream is one long-lived fetch; redirects, connect and idle time are capped here.
// Banneret Hub: Today, Needs you and the relay's event stream for an enrolled environment. One
// event stream per environment, open only while the enrolment is `configured`; an environment that
// has not joined makes no relay call. Relay answers are reshaped field by field (relay strings stay
// plain data), and the last good answer is kept so a screen is never blank while the relay is away.
import {
  BANNERET_RELAY_FEED_WS_METHODS,
  type BanneretEnrolmentView,
  type BanneretFeedDeepLink,
  type BanneretFeedEvent,
  type BanneretFeedNeedsItem,
  type BanneretFeedNeedsPage,
  type BanneretFeedNeedsRead,
  type BanneretFeedNotMeasured,
  type BanneretFeedToday,
  type BanneretFeedTodayRead,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { BanneretEnrolment } from "./Enrolment.ts";
import { RelayCallError, type RelayReply } from "./RelayClient.ts";

export interface RelayFeedOptions {
  /** First reconnect delay; it doubles up to `maxRetryMs`. */
  readonly retryMs: number;
  readonly maxRetryMs: number;
  /** The relay comments every 25 s; a stream silent for this long is reopened. */
  readonly idleMs: number;
  readonly connectMs: number;
  /** How often machine labels for deep links may be reread. */
  readonly machinesRefreshMs: number;
}

const DEFAULT_OPTIONS: RelayFeedOptions = {
  retryMs: 2000,
  maxRetryMs: 60_000,
  idleMs: 75_000,
  connectMs: 10_000,
  machinesRefreshMs: 60_000,
};

interface FeedService {
  readonly today: (visit: boolean) => Effect.Effect<BanneretFeedTodayRead>;
  readonly needs: (cursor: string | undefined) => Effect.Effect<BanneretFeedNeedsRead>;
  readonly events: Stream.Stream<BanneretFeedEvent>;
}

const NOT_JOINED = { joined: false, value: null, fetchedAt: null } as const;
const NOT_JOINED_SNAPSHOT: BanneretFeedEvent = {
  type: "snapshot",
  joined: false,
  live: false,
  since: null,
  sections: [],
  needsCount: null,
};

/** A reference, so a server built without the feed layer answers as an environment that never joined. */
export class BanneretRelayFeed extends Context.Reference<FeedService>(
  "t3/banneret/relay/RelayFeed/BanneretRelayFeed",
  {
    defaultValue: () => ({
      today: () => Effect.succeed(NOT_JOINED),
      needs: () => Effect.succeed(NOT_JOINED),
      events: Stream.concat(Stream.make(NOT_JOINED_SNAPSHOT), Stream.never),
    }),
  },
) {}

type Fields = Readonly<Record<string, unknown>>;
type LabelFor = (environmentId: string) => string | undefined;

const fields = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const text = (value: unknown, max = 500): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;
const list = (value: unknown, max = 100): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value.slice(0, max) : [];
const defined = <T>(items: ReadonlyArray<T | undefined>): Array<T> =>
  items.filter((item): item is T => item !== undefined);
const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const person = (value: unknown) => {
  const login = text(fields(value)?.login, 64);
  return login === undefined ? undefined : { login };
};

const task = (value: unknown) => {
  const source = fields(value);
  const title = text(source?.title, 300);
  if (title === undefined) return undefined;
  return { title, ...optional("url", text(source?.url, 2048)) };
};

const deepLink = (value: unknown, labelFor: LabelFor): BanneretFeedDeepLink | undefined => {
  const source = fields(value);
  const environmentId = text(source?.environmentId, 128);
  if (environmentId === undefined) return undefined;
  return {
    environmentId,
    ...optional("threadId", text(source?.threadId, 64)),
    ...optional("machineLabel", labelFor(environmentId)),
  };
};

const needsItem = (value: unknown, labelFor: LabelFor): BanneretFeedNeedsItem | undefined => {
  const source = fields(value);
  const id = text(source?.id, 64);
  const kind = text(source?.kind, 64);
  const title = text(source?.title, 300);
  const createdAt = text(source?.createdAt, 64);
  if (id === undefined || kind === undefined || title === undefined || createdAt === undefined) {
    return undefined;
  }
  return {
    id,
    kind,
    title,
    createdAt,
    ...optional("recommendation", text(source?.recommendation, 500)),
    ...optional("from", person(source?.from)),
    ...optional("url", text(source?.url, 2048)),
    ...optional("deepLink", deepLink(source?.deepLink, labelFor)),
  };
};

const notMeasured = (value: unknown): BanneretFeedNotMeasured | undefined => {
  const source = fields(value);
  const sourceName = text(source?.source, 64);
  const reason = text(source?.reason, 64);
  const since = text(source?.since, 64);
  return sourceName === undefined || reason === undefined || since === undefined
    ? undefined
    : { source: sourceName, reason, since };
};

const block = <T>(value: unknown, item: (value: unknown) => T | undefined) => {
  const source = fields(value);
  return {
    state: text(source?.state, 32) ?? "not_measured",
    items: defined(list(source?.items, 20).map(item)),
    notMeasured: defined(list(source?.notMeasured, 32).map(notMeasured)),
  };
};

const reshapeToday = (body: unknown, labelFor: LabelFor): BanneretFeedToday | undefined => {
  const source = fields(body);
  const generatedAt = text(source?.generatedAt, 64);
  if (generatedAt === undefined) return undefined;
  const needsYou = fields(source?.needsYou);
  return {
    generatedAt,
    lastVisitAt: text(source?.lastVisitAt, 64) ?? null,
    needsYou: {
      ...block(needsYou, (item) => needsItem(item, labelFor)),
      nextCursor: text(needsYou?.nextCursor, 1024) ?? null,
    },
    shipped: block(source?.shipped, (value) => {
      const item = fields(value);
      const shippedTask = task(item?.task);
      const summary = text(item?.summary, 300);
      const mergedAt = text(item?.mergedAt, 64);
      const live = text(item?.live, 32);
      return shippedTask === undefined ||
        summary === undefined ||
        mergedAt === undefined ||
        live === undefined
        ? undefined
        : { task: shippedTask, summary, mergedAt, live };
    }),
    working: block(source?.working, (value) => {
      const item = fields(value);
      const who = person(item?.person);
      const lastActivityAt = text(item?.lastActivityAt, 64);
      if (who === undefined || lastActivityAt === undefined) return undefined;
      return {
        person: who,
        lastActivityAt,
        ...optional("task", task(item?.task)),
        ...optional("branch", text(item?.branch, 200)),
        ...optional(
          "sessions",
          typeof item?.sessions === "number" && Number.isFinite(item.sessions)
            ? item.sessions
            : undefined,
        ),
        ...optional("state", text(item?.state, 32)),
        ...optional("deepLink", deepLink(item?.deepLink, labelFor)),
      };
    }),
    stuck: block(source?.stuck, (value) => {
      const item = fields(value);
      const rule = text(item?.rule, 64);
      const since = text(item?.since, 64);
      if (rule === undefined || since === undefined) return undefined;
      return {
        rule,
        since,
        ...optional("task", task(item?.task)),
        ...optional("owner", person(item?.owner)),
        ...optional("deepLink", deepLink(item?.deepLink, labelFor)),
      };
    }),
    health: block(source?.health, (value) => {
      const item = fields(value);
      const id = text(item?.id, 64);
      const label = text(item?.label, 120);
      const state = text(item?.state, 32);
      if (id === undefined || label === undefined || state === undefined) return undefined;
      return {
        id,
        label,
        state,
        observedAt: text(item?.observedAt, 64) ?? null,
        ...optional("summary", text(item?.summary, 300)),
      };
    }),
  };
};

const reshapeNeeds = (body: unknown, labelFor: LabelFor): BanneretFeedNeedsPage | undefined => {
  const source = fields(body);
  if (!Array.isArray(source?.items)) return undefined;
  return {
    items: defined(list(source.items, 100).map((item) => needsItem(item, labelFor))),
    nextCursor: text(source.nextCursor, 1024) ?? null,
  };
};

/** Environment ids named by deep links in a Today or Needs answer. */
const linkedEnvironments = (body: unknown): Set<string> => {
  const found = new Set<string>();
  const source = fields(body);
  const blocks = [source, fields(source?.needsYou), fields(source?.working), fields(source?.stuck)];
  for (const container of blocks) {
    for (const item of list(container?.items, 100)) {
      const environmentId = text(fields(fields(item)?.deepLink)?.environmentId, 128);
      if (environmentId !== undefined) found.add(environmentId);
    }
  }
  return found;
};

const sectionKinds = (body: unknown): ReadonlyArray<string> =>
  defined(list(fields(body)?.sections, 64).map((section) => text(fields(section)?.kind, 32)));

/** `visit=1` is a 1.1 addition; a 1.0 relay may refuse it (relay-v1 changelog). */
export const protocolSupportsVisit = (protocol: string | undefined): boolean => {
  const match = /^([0-9]{1,4})\.([0-9]{1,6})$/.exec(protocol ?? "");
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 1 || (major === 1 && Number(match[2]) >= 1);
};

const problemMessage = (error: RelayCallError, relay: string): string => {
  if (error.status === 0) return `Cannot reach ${relay}.`;
  if (error.code === "bad_response") return `${relay}'s answer did not match relay v1.`;
  if (error.status === 401) return `${relay} refused this machine.`;
  if (error.status === 403) return `${relay} does not allow this.`;
  if (error.retryable) return `${relay} is unavailable.`;
  return `${relay} answered ${error.status}.`;
};

const badResponse = (status: number) =>
  new RelayCallError({
    status,
    code: "bad_response",
    message: "The relay's answer did not match relay v1.",
    retryable: true,
  });

interface SseMessage {
  readonly id: string | undefined;
  readonly event: string;
  readonly data: string;
}

/** Turns text chunks into messages. */
const sseParser = () => {
  let id: string | undefined;
  let event = "";
  let data: Array<string> = [];
  let buffer = "";
  const line = (line: string): SseMessage | undefined => {
    if (line === "") {
      const message =
        data.length === 0 ? undefined : { id, event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      return message;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (name === "id" && !value.includes("\0")) id = value.slice(0, 128);
    else if (name === "event") event = value.slice(0, 64);
    else if (name === "data" && data.length < 64) data.push(value.slice(0, 64 * 1024));
    return undefined;
  };
  return (chunk: string): ReadonlyArray<SseMessage> => {
    buffer += chunk;
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = (lines.pop() ?? "").slice(0, 1024 * 1024);
    return defined(lines.map(line));
  };
};

const parseData = (data: string): Fields | undefined => {
  try {
    return fields(JSON.parse(data));
  } catch {
    return undefined;
  }
};

const make = Effect.fn("BanneretRelayFeed.make")(function* (
  overrides: Partial<RelayFeedOptions> = {},
) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const enrolment = yield* BanneretEnrolment;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const changes = yield* PubSub.unbounded<BanneretFeedEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  interface Joined {
    readonly key: string;
    readonly displayName: string;
    readonly label: string | undefined;
  }

  // Everything below belongs to one joined key (relay origin and machine id); a new key starts empty.
  let joined: Joined | null = null;
  let lastEventId: string | undefined;
  let live = false;
  let since: string | null = null;
  let sections: ReadonlyArray<string> = [];
  let protocol: string | undefined;
  let needsCount: number | null = null;
  let today: { readonly value: BanneretFeedToday; readonly fetchedAt: string } | null = null;
  let needsFirst: { readonly value: BanneretFeedNeedsPage; readonly fetchedAt: string } | null =
    null;
  let problem: { readonly message: string; readonly since: string } | null = null;
  let labels = new Map<string, string>();
  let labelsReadAt = Number.NEGATIVE_INFINITY;

  const joinedOf = (view: BanneretEnrolmentView): Joined | null =>
    view.state === "configured" && view.relayOrigin !== undefined && view.machineId !== undefined
      ? {
          key: `${view.relayOrigin} ${view.machineId}`,
          displayName: view.displayName ?? view.relayOrigin,
          label: view.label,
        }
      : null;

  const snapshot = (): BanneretFeedEvent => ({
    type: "snapshot",
    joined: joined !== null,
    live,
    since,
    sections,
    needsCount,
  });
  const publish = (event: BanneretFeedEvent) => PubSub.publish(changes, event);
  const publishSnapshot = Effect.suspend(() => publish(snapshot()));

  const stillJoined = (key: string) => joined?.key === key;

  const recordProblem = Effect.fn("BanneretRelayFeed.recordProblem")(function* (
    key: string,
    error: RelayCallError,
  ) {
    if (!stillJoined(key) || joined === null) return;
    const at = yield* nowIso;
    problem = { message: problemMessage(error, joined.displayName), since: problem?.since ?? at };
  });

  /** Rereads machine labels when a deep link names a machine this server has no label for. */
  const ensureLabels = Effect.fn("BanneretRelayFeed.ensureLabels")(function* (
    key: string,
    environmentIds: ReadonlySet<string>,
  ) {
    const missing = [...environmentIds].some((id) => !labels.has(id));
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (!missing || nowMs - labelsReadAt < options.machinesRefreshMs) return;
    labelsReadAt = nowMs;
    const next = new Map<string, string>();
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const outcome: Result.Result<RelayReply, RelayCallError> = yield* enrolment
        .signedGet(`/relay/v1/machines?limit=100${query}`)
        .pipe(Effect.result);
      if (Result.isFailure(outcome)) return;
      const body = fields(outcome.success.body);
      for (const machine of list(body?.items, 100)) {
        const source = fields(machine);
        const environmentId = text(source?.environmentId, 128);
        const label = text(source?.label, 64);
        if (environmentId !== undefined && label !== undefined && !next.has(environmentId)) {
          next.set(environmentId, label);
        }
      }
      cursor = text(body?.nextCursor, 1024) ?? null;
      if (cursor === null) break;
    }
    if (!stillJoined(key)) return;
    if (joined?.label !== undefined) next.set(environmentId, joined.label);
    labels = next;
  });

  const read = Effect.fn("BanneretRelayFeed.read")(function* <T>(
    target: string,
    reshape: (body: unknown, labelFor: LabelFor) => T | undefined,
  ) {
    // A read can come before the supervisor has seen the latest enrolment change.
    yield* adopt(joinedOf(yield* enrolment.status));
    const current = joined;
    if (current === null) return { ok: false as const, joined: false };
    const outcome = yield* enrolment.signedGet(target).pipe(
      Effect.flatMap((reply) =>
        Effect.gen(function* () {
          yield* ensureLabels(current.key, linkedEnvironments(reply.body));
          const labelFor: LabelFor = (environmentId) => labels.get(environmentId);
          const value = reshape(reply.body, labelFor);
          return value === undefined ? yield* badResponse(reply.status) : value;
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(outcome)) {
      if (outcome.failure.code === "not_configured") return { ok: false as const, joined: false };
      yield* recordProblem(current.key, outcome.failure);
      return { ok: false as const, joined: stillJoined(current.key) };
    }
    if (stillJoined(current.key)) problem = null;
    return {
      ok: true as const,
      key: current.key,
      value: outcome.success,
      fetchedAt: yield* nowIso,
    };
  });

  const withProblem = () => (problem === null ? {} : { problem });

  const readToday = Effect.fn("BanneretRelayFeed.today")(function* (open: boolean) {
    yield* adopt(joinedOf(yield* enrolment.status));
    const key = joined?.key;
    if (open && protocol === undefined && key !== undefined) yield* refreshSections(key);
    const visit = open && protocolSupportsVisit(protocol);
    const outcome = yield* read(
      visit ? "/relay/v1/today?visit=1" : "/relay/v1/today",
      reshapeToday,
    );
    if (outcome.ok) {
      if (stillJoined(outcome.key)) today = { value: outcome.value, fetchedAt: outcome.fetchedAt };
      return { joined: true, value: outcome.value, fetchedAt: outcome.fetchedAt };
    }
    if (!outcome.joined) return NOT_JOINED;
    return {
      joined: true,
      value: today?.value ?? null,
      fetchedAt: today?.fetchedAt ?? null,
      ...withProblem(),
    };
  });

  const readNeeds = Effect.fn("BanneretRelayFeed.needs")(function* (cursor: string | undefined) {
    const query = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const outcome = yield* read(`/relay/v1/needs?limit=50${query}`, reshapeNeeds);
    if (outcome.ok) {
      if (cursor === undefined && stillJoined(outcome.key)) {
        needsFirst = { value: outcome.value, fetchedAt: outcome.fetchedAt };
      }
      return { joined: true, value: outcome.value, fetchedAt: outcome.fetchedAt };
    }
    if (!outcome.joined) return NOT_JOINED;
    const cached = cursor === undefined ? needsFirst : null;
    return {
      joined: true,
      value: cached?.value ?? null,
      fetchedAt: cached?.fetchedAt ?? null,
      ...withProblem(),
    };
  });

  const refreshSections = (key: string) =>
    enrolment.signedGet("/relay/v1/capabilities").pipe(
      Effect.flatMap((reply) =>
        Effect.suspend(() => {
          if (!stillJoined(key)) return Effect.void;
          sections = sectionKinds(reply.body);
          protocol = text(fields(reply.body)?.protocol, 16);
          return publishSnapshot;
        }),
      ),
      Effect.ignore,
    );

  const setLive = Effect.fn("BanneretRelayFeed.setLive")(function* (key: string, next: boolean) {
    if (!stillJoined(key) || live === next) return;
    live = next;
    since = yield* nowIso;
    yield* publishSnapshot;
  });

  const handleMessage = Effect.fn("BanneretRelayFeed.handleMessage")(function* (
    key: string,
    message: SseMessage,
  ) {
    if (!stillJoined(key)) return;
    if (message.id !== undefined && message.id !== "") lastEventId = message.id;
    const data = parseData(message.data);
    switch (message.event) {
      case "needs.changed": {
        const count = data?.count;
        if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
          needsCount = count;
          yield* publish({ type: "changed", reason: "needs", needsCount: count });
        } else {
          yield* publish({ type: "changed", reason: "needs" });
        }
        return;
      }
      case "mention":
        yield* publish({ type: "changed", reason: "mention" });
        return;
      case "capabilities.changed":
        yield* refreshSections(key);
        return;
      case "reset":
        // The relay cannot replay what this server missed: refetch everything.
        needsCount = null;
        yield* refreshSections(key);
        yield* publish({ type: "changed", reason: "reset" });
        return;
      default:
        // bundle.changed and staff.removed belong to other parts of the Hub; unknown events are ignored.
        return;
    }
  });

  /** One connection: open, read until it ends or goes quiet. Fails with the reason it stopped. */
  const connectOnce = Effect.fn("BanneretRelayFeed.connectOnce")(function* (
    key: string,
    opened: Effect.Effect<void>,
  ) {
    const target = "/relay/v1/events";
    const signed = yield* enrolment.signStream(target);
    const headers = { ...signed.headers };
    if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${signed.origin}${target}`, { method: "GET", headers, redirect: "manual", signal }),
      catch: () =>
        new RelayCallError({
          status: 0,
          code: "network",
          message: "The relay could not be reached.",
          retryable: true,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(options.connectMs),
        orElse: () =>
          Effect.fail(
            new RelayCallError({
              status: 0,
              code: "network",
              message: "The relay did not answer in time.",
              retryable: true,
            }),
          ),
      }),
    );
    const body = response.body;
    if (response.status !== 200 || body === null) {
      yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore);
      const retryAfter = Number(response.headers.get("retry-after"));
      return yield* new RelayCallError({
        status: response.status,
        code:
          response.status >= 300 && response.status < 400 ? "redirect" : `http_${response.status}`,
        message: `The relay answered ${response.status}.`,
        retryable: response.status === 429 || response.status >= 500,
        ...(Number.isFinite(retryAfter) && retryAfter >= 0
          ? { retryAfterMs: retryAfter * 1000 }
          : {}),
      });
    }
    yield* opened;
    const parse = sseParser();
    yield* Stream.fromReadableStream({
      evaluate: () => body,
      onError: () =>
        new RelayCallError({
          status: 0,
          code: "network",
          message: "The relay's event stream broke.",
          retryable: true,
        }),
    }).pipe(
      Stream.decodeText(),
      // Comment lines (every 25 s) are chunks too, so a healthy stream never times out.
      Stream.timeoutOrElse({
        duration: Duration.millis(options.idleMs),
        orElse: () =>
          Stream.fail(
            new RelayCallError({
              status: 0,
              code: "network",
              message: "The relay's event stream went quiet.",
              retryable: true,
            }),
          ),
      }),
      Stream.runForEach((chunk) =>
        Effect.forEach(parse(chunk), (message) => handleMessage(key, message), {
          discard: true,
        }),
      ),
    );
  });

  /** Keeps the stream open for one joined key until the key changes (this fiber is interrupted). */
  const follow = Effect.fn("BanneretRelayFeed.follow")(function* (key: string) {
    let delay = 0;
    let connections = 0;
    yield* refreshSections(key);
    for (;;) {
      const outcome = yield* connectOnce(
        key,
        Effect.gen(function* () {
          connections += 1;
          delay = 0;
          yield* setLive(key, true);
          // Without a resume id the relay cannot replay what a reconnect missed.
          if (connections > 1) yield* publish({ type: "changed", reason: "reconnected" });
        }),
      ).pipe(Effect.result);
      yield* setLive(key, false);
      const error = Result.isFailure(outcome) ? outcome.failure : undefined;
      // A refusal (revoked, clock) is settled by the enrolment's own health check; wait long.
      const refused = error !== undefined && (error.status === 401 || error.status === 403);
      delay = refused
        ? options.maxRetryMs
        : Math.min(options.maxRetryMs, delay === 0 ? options.retryMs : delay * 2);
      const wait = Math.max(delay, Math.min(options.maxRetryMs, error?.retryAfterMs ?? 0));
      yield* Effect.sleep(Duration.millis(wait));
    }
  });

  // Adopting a joined key (or none) resets everything that belonged to the previous one.
  const layerScope = yield* Effect.scope;
  const adoptLock = yield* Semaphore.make(1);
  let follower: Fiber.Fiber<never, never> | undefined;
  const adopt = (next: Joined | null) =>
    adoptLock.withPermits(1)(
      Effect.gen(function* () {
        if (next?.key === joined?.key) return;
        if (follower !== undefined) yield* Fiber.interrupt(follower);
        follower = undefined;
        joined = next;
        lastEventId = undefined;
        live = false;
        since = null;
        sections = [];
        protocol = undefined;
        needsCount = null;
        today = null;
        needsFirst = null;
        problem = null;
        labels = new Map();
        labelsReadAt = Number.NEGATIVE_INFINITY;
        if (next !== null) {
          if (next.label !== undefined) labels.set(environmentId, next.label);
          follower = yield* Effect.forkIn(follow(next.key) as Effect.Effect<never>, layerScope);
        }
        yield* publishSnapshot;
      }),
    );

  // One supervisor: follows the enrolment, so the stream runs only while configured.
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const changed = yield* enrolment.nextChange;
        yield* adopt(joinedOf(yield* enrolment.status));
        yield* changed;
      }),
    ),
  );

  const events = Stream.callback<BanneretFeedEvent>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, snapshot());
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((event) => Effect.sync(() => Queue.offerUnsafe(mailbox, event))),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 64, strategy: "sliding" },
  );

  const service: FeedService = { today: readToday, needs: readNeeds, events };
  return service;
});

export const layerWith = (options: Partial<RelayFeedOptions>) =>
  Layer.effect(BanneretRelayFeed, make(options));

export const layer = layerWith({});

/** Handlers for the feed RPCs, spread into the WebSocket handler group. */
export const rpcHandlers = {
  [BANNERET_RELAY_FEED_WS_METHODS.today]: (input: { readonly visit?: boolean | undefined }) =>
    Effect.flatMap(BanneretRelayFeed, (feed) => feed.today(input.visit === true)),
  [BANNERET_RELAY_FEED_WS_METHODS.needs]: (input: { readonly cursor?: string | undefined }) =>
    Effect.flatMap(BanneretRelayFeed, (feed) => feed.needs(input.cursor)),
  [BANNERET_RELAY_FEED_WS_METHODS.feed]: () =>
    Stream.unwrap(Effect.map(BanneretRelayFeed, (feed) => feed.events)),
};
