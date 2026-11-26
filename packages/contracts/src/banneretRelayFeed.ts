// Banneret Hub: Today, Needs you, the board, the feed and one task from the company relay
// (docs/banneret/relay-v1). The server makes every relay call and reshapes the answers into the
// views below; clients never see the token or key. Relay failures are data, not errors, so a screen
// always has the last good answer and its age to show.
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";

export const BANNERET_RELAY_FEED_WS_METHODS = {
  today: "banneretRelay.today",
  needs: "banneretRelay.needs",
  feed: "banneretRelay.feed",
  feedPage: "banneretRelay.feedPage",
  graveyardPage: "banneretRelay.graveyardPage",
  task: "banneretRelay.task",
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

/** Where a board task lives in its tracker (relay-v1 `BoardTaskRef`). */
export const BanneretBoardTaskRef = Schema.Struct({
  tracker: Schema.String,
  host: Schema.optional(Schema.String),
  scope: Schema.String,
  key: Schema.String,
  url: Schema.String,
});

/** `state` is open: `active`, `stale`, `expired`, `paused`, `conflict` are known. */
export const BanneretBoardLease = Schema.Struct({
  holder: BanneretFeedPerson,
  state: Schema.String,
  since: Schema.String,
  lastSignalAt: Schema.String,
  staleAt: Schema.String,
  expiresAt: Schema.String,
});
export type BanneretBoardLease = typeof BanneretBoardLease.Type;

/** One task on the board. `column` and `status` are open strings the relay computed. */
export const BanneretBoardCard = Schema.Struct({
  task: Schema.Struct({ id: Schema.String, title: Schema.String, ref: BanneretBoardTaskRef }),
  column: Schema.String,
  status: Schema.String,
  statusWhy: Schema.String,
  lease: Schema.optional(BanneretBoardLease),
  pr: Schema.optional(
    Schema.Struct({ number: Schema.Number, url: Schema.String, state: Schema.String }),
  ),
  checks: Schema.optional(Schema.Struct({ state: Schema.String })),
  restsOn: Schema.Array(Schema.String),
});
export type BanneretBoardCard = typeof BanneretBoardCard.Type;

/** The relay's snapshot `board` file, reshaped field by field. */
export const BanneretBoard = Schema.Struct({
  state: Schema.String,
  notMeasured: Schema.Array(BanneretFeedNotMeasured),
  columns: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  cards: Schema.Array(BanneretBoardCard),
});
export type BanneretBoard = typeof BanneretBoard.Type;

/**
 * The board as last read from the relay's snapshot, kept with its age when the relay is away.
 * `atWork` are task ids with a live agent session in the snapshot `work` file (the ring);
 * `leases` and `checked` are the board section's flags of those names.
 */
export const BanneretFeedBoardRead = Schema.Struct({
  value: Schema.NullOr(BanneretBoard),
  fetchedAt: Schema.NullOr(Schema.String),
  atWork: Schema.Array(Schema.String),
  leases: Schema.Boolean,
  checked: Schema.Boolean,
  problem: Schema.optional(Schema.Struct({ message: Schema.String, since: Schema.String })),
});
export type BanneretFeedBoardRead = typeof BanneretFeedBoardRead.Type;

/** A task as the relay names it (relay-v1 `BoardTask`). */
export const BanneretBoardTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  ref: BanneretBoardTaskRef,
});
export type BanneretBoardTask = typeof BanneretBoardTask.Type;

/**
 * One derived feed entry. `type`, `importance` and `status` are open strings; an unknown `type` is
 * shown generically and `importance` only styles.
 */
export const BanneretFeedEntry = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  at: Schema.String,
  author: Schema.optional(BanneretFeedPerson),
  importance: Schema.String,
  summary: Schema.String,
  link: Schema.optional(Schema.String),
  task: Schema.optional(BanneretBoardTask),
  status: Schema.optional(Schema.String),
});
export type BanneretFeedEntry = typeof BanneretFeedEntry.Type;

/** The relay's `feed` snapshot file or one `GET /feed` page, newest first. */
export const BanneretFeedEntryPage = Schema.Struct({
  entries: Schema.Array(BanneretFeedEntry),
  nextCursor: Schema.NullOr(Schema.String),
});
export type BanneretFeedEntryPage = typeof BanneretFeedEntryPage.Type;

/** One task ruled dead, always with its cause. */
export const BanneretGraveyardEntry = Schema.Struct({
  task: BanneretBoardTask,
  cause: Schema.String,
  ruledAt: Schema.String,
  by: Schema.optional(BanneretFeedPerson),
  link: Schema.optional(Schema.String),
});
export type BanneretGraveyardEntry = typeof BanneretGraveyardEntry.Type;

/** The relay's `graveyard` snapshot file or one `GET /graveyard` page, newest ruling first. */
export const BanneretGraveyardPage = Schema.Struct({
  entries: Schema.Array(BanneretGraveyardEntry),
  nextCursor: Schema.NullOr(Schema.String),
});
export type BanneretGraveyardPage = typeof BanneretGraveyardPage.Type;

/** A snapshot file as last read, kept with its age when the relay is away. */
const snapshotRead = <S extends Schema.Top>(value: S) =>
  Schema.Struct({
    value: Schema.NullOr(value),
    fetchedAt: Schema.NullOr(Schema.String),
    problem: Schema.optional(Schema.Struct({ message: Schema.String, since: Schema.String })),
  });

export const BanneretFeedEntriesRead = snapshotRead(BanneretFeedEntryPage);
export type BanneretFeedEntriesRead = typeof BanneretFeedEntriesRead.Type;
export const BanneretGraveyardRead = snapshotRead(BanneretGraveyardPage);
export type BanneretGraveyardRead = typeof BanneretGraveyardRead.Type;

/** An older page through `GET /feed` or `GET /graveyard`; `joined` false means nothing was asked. */
export const BanneretFeedEntryPageRead = read(BanneretFeedEntryPage);
export type BanneretFeedEntryPageRead = typeof BanneretFeedEntryPageRead.Type;
export const BanneretGraveyardPageRead = read(BanneretGraveyardPage);
export type BanneretGraveyardPageRead = typeof BanneretGraveyardPageRead.Type;

/** A task's preview (relay-v1 `TaskPreview`). `state` is open: `building`, `ready`, `failed` are known. */
export const BanneretTaskPreview = Schema.Struct({
  state: Schema.String,
  url: Schema.optional(Schema.String),
});
export type BanneretTaskPreview = typeof BanneretTaskPreview.Type;

/** The sign-off record of a task with a `checked` label; `ignoredReason` says why it does not count. */
export const BanneretTaskChecked = Schema.Struct({
  by: BanneretFeedPerson,
  at: Schema.String,
  valid: Schema.Boolean,
  ignoredReason: Schema.optional(Schema.String),
});
export type BanneretTaskChecked = typeof BanneretTaskChecked.Type;

/** `GET /tasks/{taskId}` (relay-v1 `TaskRead`): the board card plus its preview and sign-off. */
export const BanneretTask = Schema.Struct({
  ...BanneretBoardCard.fields,
  preview: Schema.optional(BanneretTaskPreview),
  checked: Schema.optional(BanneretTaskChecked),
});
export type BanneretTask = typeof BanneretTask.Type;

/**
 * One task read. `notFound` is true when the relay does not know the task (404); `joined` false
 * means nothing was asked of a relay.
 */
export const BanneretTaskRead = Schema.Struct({
  joined: Schema.Boolean,
  value: Schema.NullOr(BanneretTask),
  fetchedAt: Schema.NullOr(Schema.String),
  notFound: Schema.optional(Schema.Boolean),
  problem: Schema.optional(Schema.Struct({ message: Schema.String, since: Schema.String })),
});
export type BanneretTaskRead = typeof BanneretTaskRead.Type;

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
  /** Null while the relay advertises no board section, or before it was looked at. */
  board: Schema.NullOr(BanneretFeedBoardRead),
  /** Null while the relay advertises no feed section, or before it was looked at. */
  feed: Schema.NullOr(BanneretFeedEntriesRead),
  /** Null while the feed section lacks the `graveyard` flag, or before it was looked at. */
  graveyard: Schema.NullOr(BanneretGraveyardRead),
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

const WsBanneretRelayFeedPageRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.feedPage, {
  /** The `nextCursor` of the feed file or of the previous page. */
  payload: Schema.Struct({ cursor: Schema.String }),
  success: BanneretFeedEntryPageRead,
  error: EnvironmentAuthorizationError,
});

const WsBanneretRelayGraveyardPageRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.graveyardPage, {
  payload: Schema.Struct({ cursor: Schema.String }),
  success: BanneretGraveyardPageRead,
  error: EnvironmentAuthorizationError,
});

const WsBanneretRelayTaskRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.task, {
  payload: Schema.Struct({ taskId: Schema.String }),
  success: BanneretTaskRead,
  error: EnvironmentAuthorizationError,
});

export const BANNERET_RELAY_FEED_RPCS = [
  WsBanneretRelayTodayRpc,
  WsBanneretRelayNeedsRpc,
  WsBanneretRelayFeedRpc,
  WsBanneretRelayFeedPageRpc,
  WsBanneretRelayGraveyardPageRpc,
  WsBanneretRelayTaskRpc,
] as const;

export const BANNERET_RELAY_FEED_RPC_SCOPES = {
  [BANNERET_RELAY_FEED_WS_METHODS.today]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.needs]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.feed]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.feedPage]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.graveyardPage]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.task]: AuthOrchestrationOperateScope,
} as const;

export const BANNERET_RELAY_FEED_RPC_AGGREGATES = {
  [BANNERET_RELAY_FEED_WS_METHODS.today]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.needs]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.feed]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.feedPage]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.graveyardPage]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.task]: "banneret-relay",
} as const;
