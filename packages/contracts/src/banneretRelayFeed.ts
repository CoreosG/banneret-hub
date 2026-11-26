// Banneret Hub: Today and Needs you from the company relay (docs/banneret/relay-v1: GET /today,
// GET /needs, GET /events, GET /capabilities). The server makes every relay call and reshapes the
// answers into the views below; clients never see the token or key. Relay failures are data, not
// errors, so a screen always has the last good answer and its age to show.
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";

export const BANNERET_RELAY_FEED_WS_METHODS = {
  today: "banneretRelay.today",
  needs: "banneretRelay.needs",
  feed: "banneretRelay.feed",
} as const;

/** Where an item opens: a thread on a machine. `machineLabel` is the relay's label for that machine. */
export const BanneretFeedDeepLink = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.optional(Schema.String),
  machineLabel: Schema.optional(Schema.String),
});
export type BanneretFeedDeepLink = typeof BanneretFeedDeepLink.Type;

export const BanneretFeedPerson = Schema.Struct({ login: Schema.String });

export const BanneretFeedTask = Schema.Struct({
  title: Schema.String,
  url: Schema.optional(Schema.String),
});

/** `kind` is an open set; an unknown kind is shown as a generic item. */
export const BanneretFeedNeedsItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  recommendation: Schema.optional(Schema.String),
  from: Schema.optional(BanneretFeedPerson),
  url: Schema.optional(Schema.String),
  deepLink: Schema.optional(BanneretFeedDeepLink),
  createdAt: Schema.String,
});
export type BanneretFeedNeedsItem = typeof BanneretFeedNeedsItem.Type;

export const BanneretFeedNotMeasured = Schema.Struct({
  source: Schema.String,
  reason: Schema.String,
  since: Schema.String,
});
export type BanneretFeedNotMeasured = typeof BanneretFeedNotMeasured.Type;

const block = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    state: Schema.String,
    items: Schema.Array(item),
    notMeasured: Schema.Array(BanneretFeedNotMeasured),
  });

export const BanneretFeedShippedItem = Schema.Struct({
  task: BanneretFeedTask,
  summary: Schema.String,
  mergedAt: Schema.String,
  live: Schema.String,
});

export const BanneretFeedWorkingItem = Schema.Struct({
  person: BanneretFeedPerson,
  task: Schema.optional(BanneretFeedTask),
  branch: Schema.optional(Schema.String),
  sessions: Schema.optional(Schema.Number),
  state: Schema.optional(Schema.String),
  lastActivityAt: Schema.String,
  deepLink: Schema.optional(BanneretFeedDeepLink),
});

export const BanneretFeedStuckItem = Schema.Struct({
  rule: Schema.String,
  since: Schema.String,
  task: Schema.optional(BanneretFeedTask),
  owner: Schema.optional(BanneretFeedPerson),
  deepLink: Schema.optional(BanneretFeedDeepLink),
});

export const BanneretFeedHealthItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  state: Schema.String,
  summary: Schema.optional(Schema.String),
  observedAt: Schema.NullOr(Schema.String),
});

/** The five Today blocks, in the relay's order. */
export const BanneretFeedToday = Schema.Struct({
  generatedAt: Schema.String,
  lastVisitAt: Schema.NullOr(Schema.String),
  needsYou: Schema.Struct({
    state: Schema.String,
    items: Schema.Array(BanneretFeedNeedsItem),
    nextCursor: Schema.NullOr(Schema.String),
    notMeasured: Schema.Array(BanneretFeedNotMeasured),
  }),
  shipped: block(BanneretFeedShippedItem),
  working: block(BanneretFeedWorkingItem),
  stuck: block(BanneretFeedStuckItem),
  health: block(BanneretFeedHealthItem),
});
export type BanneretFeedToday = typeof BanneretFeedToday.Type;

export const BanneretFeedNeedsPage = Schema.Struct({
  items: Schema.Array(BanneretFeedNeedsItem),
  nextCursor: Schema.NullOr(Schema.String),
});
export type BanneretFeedNeedsPage = typeof BanneretFeedNeedsPage.Type;

/**
 * A read: the answer, or the last good one when the relay could not answer (`problem` says why).
 * `joined` false means this machine has not joined a company and nothing was asked of a relay.
 */
const read = <S extends Schema.Top>(value: S) =>
  Schema.Struct({
    joined: Schema.Boolean,
    value: Schema.NullOr(value),
    fetchedAt: Schema.NullOr(Schema.String),
    problem: Schema.optional(Schema.Struct({ message: Schema.String, since: Schema.String })),
  });

export const BanneretFeedTodayRead = read(BanneretFeedToday);
export type BanneretFeedTodayRead = typeof BanneretFeedTodayRead.Type;
export const BanneretFeedNeedsRead = read(BanneretFeedNeedsPage);
export type BanneretFeedNeedsRead = typeof BanneretFeedNeedsRead.Type;

/**
 * The live feed: the whole state each time, so a client that only keeps the latest value misses
 * nothing. `revision` moves whenever Today or Needs you may have changed (`needs.changed`,
 * `mention`, a `reset`, or a reconnect that may have missed events); the client refetches then.
 */
export const BanneretFeedState = Schema.Struct({
  joined: Schema.Boolean,
  live: Schema.Boolean,
  /** When the stream last went live or down. */
  since: Schema.NullOr(Schema.String),
  /** False until the relay's capabilities have been read. */
  sectionsKnown: Schema.Boolean,
  /** The section kinds the relay advertises. */
  sections: Schema.Array(Schema.String),
  /** The open needs-you count from the last `needs.changed`, if one arrived. */
  needsCount: Schema.NullOr(Schema.Number),
  revision: Schema.Number,
});
export type BanneretFeedState = typeof BanneretFeedState.Type;

const WsBanneretRelayTodayRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.today, {
  /** `visit` only when the person actually opens Today. */
  payload: Schema.Struct({ visit: Schema.optional(Schema.Boolean) }),
  success: BanneretFeedTodayRead,
  error: EnvironmentAuthorizationError,
});

const WsBanneretRelayNeedsRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.needs, {
  payload: Schema.Struct({ cursor: Schema.optional(Schema.String) }),
  success: BanneretFeedNeedsRead,
  error: EnvironmentAuthorizationError,
});

const WsBanneretRelayFeedRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.feed, {
  payload: Schema.Struct({}),
  success: BanneretFeedState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const BANNERET_RELAY_FEED_RPCS = [
  WsBanneretRelayTodayRpc,
  WsBanneretRelayNeedsRpc,
  WsBanneretRelayFeedRpc,
] as const;

export const BANNERET_RELAY_FEED_RPC_SCOPES = {
  [BANNERET_RELAY_FEED_WS_METHODS.today]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.needs]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.feed]: AuthOrchestrationOperateScope,
} as const;

export const BANNERET_RELAY_FEED_RPC_AGGREGATES = {
  [BANNERET_RELAY_FEED_WS_METHODS.today]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.needs]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.feed]: "banneret-relay",
} as const;
