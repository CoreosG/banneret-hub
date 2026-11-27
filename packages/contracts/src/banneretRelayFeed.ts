// Banneret Hub: Today, Needs you, the board, the map, the feed and one task from the company relay
// (docs/banneret/relay-v1). The server makes every relay call and reshapes the answers into the
// views below; clients never see the token or key. Relay failures are data, not errors, so a screen
// always has the last good answer and its age to show.
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";

import { ChatAsk, ChatRead, ChatNotice, ChannelAction, ChannelResult } from "./banneretChat.ts";

export const BANNERET_RELAY_FEED_WS_METHODS = {
  chat: "banneretRelay.chat",
  today: "banneretRelay.today",
  needs: "banneretRelay.needs",
  feed: "banneretRelay.feed",
  room: "banneretRelay.teamRoom",
  agents: "banneretRelay.teamAgents",
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
  ask: Schema.optional(ChatAsk),
  chatRead: Schema.optional(ChatRead),
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
  kind: Schema.optional(Schema.String),
  source: Schema.String,
  reason: Schema.String,
  since: Schema.String,
  /** One plain sentence naming the rule that failed, when the relay gives one. */
  detail: Schema.optional(Schema.String),
});
export type BanneretFeedNotMeasured = typeof BanneretFeedNotMeasured.Type;

const block = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    state: Schema.String,
    items: Schema.Array(item),
    notMeasured: Schema.Array(BanneretFeedNotMeasured),
  });

/** Where a board task lives in its tracker (relay-v1 `BoardTaskRef`). */
export const BanneretBoardTaskRef = Schema.Struct({
  tracker: Schema.String,
  host: Schema.optional(Schema.String),
  scope: Schema.String,
  key: Schema.String,
  url: Schema.String,
});

/** The pull request that shipped: `repo` is the `owner/name` display string. */
export const BanneretFeedShippedPr = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  repo: Schema.String,
});
export type BanneretFeedShippedPr = typeof BanneretFeedShippedPr.Type;

/** One merged pull request. It names and links itself; `ref` is the task's tracker ref when known. */
export const BanneretFeedShippedItem = Schema.Struct({
  task: BanneretFeedTask,
  pr: BanneretFeedShippedPr,
  ref: Schema.optional(BanneretBoardTaskRef),
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
  deepLink: Schema.optional(BanneretFeedDeepLink),
});

/** What a stuck item without a task is about: `owner/name`, a CI run, a watched job. At least repo or job. */
export const BanneretFeedStuckSubject = Schema.Struct({
  repo: Schema.optional(Schema.String),
  run: Schema.optional(Schema.Struct({ name: Schema.String, url: Schema.String })),
  job: Schema.optional(Schema.Struct({ name: Schema.String, url: Schema.optional(Schema.String) })),
});

export const BanneretFeedStuckItem = Schema.Struct({
  rules: Schema.Array(Schema.String),
  since: Schema.String,
  task: Schema.optional(BanneretFeedTask),
  subject: Schema.optional(BanneretFeedStuckSubject),
  owner: Schema.optional(BanneretFeedPerson),
  deepLink: Schema.optional(BanneretFeedDeepLink),
});

export const BanneretFeedHealthItem = Schema.Struct({
  source: Schema.String,
  kind: Schema.String,
  id: Schema.String,
  label: Schema.String,
  state: Schema.String,
  summary: Schema.optional(Schema.String),
  observedAt: Schema.NullOr(Schema.String),
});

/** The five Today blocks, in the relay's order. */
export const BanneretFeedToday = Schema.Struct({
  generatedAt: Schema.String,
  needsYou: Schema.Struct({
    state: Schema.String,
    items: Schema.Array(BanneretFeedNeedsItem),
    nextCursor: Schema.NullOr(Schema.String),
    notMeasured: Schema.Array(BanneretFeedNotMeasured),
  }),
  shipped: block(BanneretFeedShippedItem),
  working: block(BanneretFeedWorkingItem),
  stuck: block(BanneretFeedStuckItem),
  health: Schema.optional(
    Schema.Struct({
      ...block(BanneretFeedHealthItem).fields,
      alarms: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          sourceId: Schema.String,
          severity: Schema.Literals(["info", "warning", "critical"]),
          title: Schema.String,
          firedAt: Schema.String,
          detail: Schema.optional(Schema.String),
          url: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
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

/** `state` is open: `active`, `stale`, `expired`, `paused`, `conflict` are known. */
export const BanneretBoardLease = Schema.Struct({
  claim: Schema.optional(Schema.String),
  holder: BanneretFeedPerson,
  state: Schema.String,
  since: Schema.String,
  lastSignalAt: Schema.String,
  staleAt: Schema.String,
  expiresAt: Schema.String,
});
export type BanneretBoardLease = typeof BanneretBoardLease.Type;

/**
 * A task as the relay names it (relay-v1 `BoardTask`): when its issue was opened, and when it was
 * closed (null while open).
 */
export const BanneretBoardTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  ref: BanneretBoardTaskRef,
  openedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
});
export type BanneretBoardTask = typeof BanneretBoardTask.Type;

/** One linked pull request. `state` and `checks.state` are open strings. */
const ApprovalPerson = Schema.Struct({ id: Schema.String, login: Schema.String });
export const BanneretPrRules = Schema.Struct({
  baseBranch: Schema.NonEmptyString,
  approvals: Schema.NullOr(
    Schema.Struct({
      required: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      have: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      codeOwners: Schema.Struct({
        required: Schema.Boolean,
        satisfiedBy: Schema.optional(Schema.Array(ApprovalPerson)),
        owners: Schema.Array(Schema.String),
      }),
      lastPushApproval: Schema.Boolean,
      lastPushSatisfied: Schema.Boolean,
      stale: Schema.Boolean,
    }),
  ),
  canApprove: Schema.Array(ApprovalPerson),
  youCanApprove: Schema.Boolean,
});
export const BanneretBoardPr = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  state: Schema.String,
  rules: Schema.optional(BanneretPrRules),
  checks: Schema.optional(Schema.Struct({ state: Schema.String })),
});
export type BanneretBoardPr = typeof BanneretBoardPr.Type;

/**
 * The latest counted release of a task (relay-v1 "Lease protocol"), present while no claim stands.
 * `reason` is an open string; `reasonText` and `note` are plain text, never rendered as markup.
 */
export const BanneretLastRelease = Schema.Struct({
  by: BanneretFeedPerson,
  at: Schema.String,
  reason: Schema.String,
  /** Written as free to continue, and nobody is assigned now. */
  freeToContinue: Schema.Boolean,
  reasonText: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});
export type BanneretLastRelease = typeof BanneretLastRelease.Type;

/** One task on the board. `column` and `status` are open strings the relay computed. */
export const BanneretBoardCard = Schema.Struct({
  task: BanneretBoardTask,
  /** Open: `issue`, `pull_request` or `draft`; an unknown kind shows like `issue`. */
  kind: Schema.String,
  column: Schema.String,
  status: Schema.String,
  statusWhy: Schema.String,
  lease: Schema.optional(BanneretBoardLease),
  lastRelease: Schema.optional(BanneretLastRelease),
  /**
   * Everyone the tracker names as assigned, in its order; empty when nobody is. An assignee is not
   * a lease: a card can be assigned with no `lease` (Taken, not claimed).
   */
  assignees: Schema.Array(BanneretFeedPerson),
  /** Every linked pull request, oldest first; empty when none is linked. */
  prs: Schema.Array(BanneretBoardPr),
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
 * One board of the relay's `boards` index with its own file. `mode` and `source.kind` are open
 * tokens (`dev` and `filter` today). `board` is null while its `board.<id>` file is missing or
 * unreadable; the rest of the index still shows.
 */
export const BanneretBoardEntry = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  mode: Schema.String,
  source: Schema.Struct({ kind: Schema.String, url: Schema.optional(Schema.String) }),
  counts: Schema.Record(Schema.String, Schema.Number),
  board: Schema.NullOr(BanneretBoard),
});
export type BanneretBoardEntry = typeof BanneretBoardEntry.Type;

/** Every board the relay publishes, in its order. Task ids are relay-wide across them. */
export const BanneretBoards = Schema.Struct({ boards: Schema.Array(BanneretBoardEntry) });
export type BanneretBoards = typeof BanneretBoards.Type;

/**
 * Every card on every board, in board order. A task id is relay-wide, so a task that two boards
 * show is listed once, with its first board's card.
 */
export function allBoardCards(
  boards: BanneretBoards | null | undefined,
): ReadonlyArray<BanneretBoardCard> {
  const seen = new Set<string>();
  const cards: Array<BanneretBoardCard> = [];
  for (const entry of boards?.boards ?? []) {
    for (const card of entry.board?.cards ?? []) {
      if (seen.has(card.task.id)) continue;
      seen.add(card.task.id);
      cards.push(card);
    }
  }
  return cards;
}

/**
 * The boards as last read from the relay's snapshot, kept with their age when the relay is away.
 * `atWork` are task ids with a live agent session in the snapshot `work` file (the ring);
 * `leases` and `checked` are the board section's flags of those names.
 */
export const BanneretFeedBoardRead = Schema.Struct({
  value: Schema.NullOr(BanneretBoards),
  fetchedAt: Schema.NullOr(Schema.String),
  atWork: Schema.Array(Schema.String),
  leases: Schema.Boolean,
  checked: Schema.Boolean,
  problem: Schema.optional(Schema.Struct({ message: Schema.String, since: Schema.String })),
});
export type BanneretFeedBoardRead = typeof BanneretFeedBoardRead.Type;

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

/** A stage of the build plan, drawn in ascending `order`. */
export const BanneretMapStage = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  order: Schema.Number,
});
export type BanneretMapStage = typeof BanneretMapStage.Type;

/**
 * One item of the build plan. `status` is the board's open vocabulary; `task` is the board task the
 * item resolves to, absent when it has none. `restsOn` lists item ids; `blockedBy` the ones among
 * them that block it directly.
 */
export const BanneretMapItem = Schema.Struct({
  id: Schema.String,
  stageId: Schema.String,
  title: Schema.String,
  status: Schema.String,
  statusWhy: Schema.String,
  task: Schema.optional(BanneretBoardTask),
  restsOn: Schema.Array(Schema.String),
  blockedBy: Schema.Array(Schema.String),
});
export type BanneretMapItem = typeof BanneretMapItem.Type;

const StatusCounts = Schema.Record(Schema.String, Schema.Number);

/** The relay's snapshot `map` file (SnapshotMap), reshaped field by field. */
export const BanneretMap = Schema.Struct({
  state: Schema.String,
  notMeasured: Schema.Array(BanneretFeedNotMeasured),
  stages: Schema.Array(BanneretMapStage),
  items: Schema.Array(BanneretMapItem),
  counters: Schema.Struct({
    byStatus: StatusCounts,
    byStage: Schema.Record(Schema.String, StatusCounts),
  }),
});
export type BanneretMap = typeof BanneretMap.Type;

/**
 * The map as last read from the relay's snapshot, kept with its age when the relay is away.
 * `atWork` are task ids with a live agent session in the `work` file (the ring); `restsOn` is the
 * map section's flag of that name; `checked` says the relay applies the sign-off rule.
 */
export const BanneretFeedMapRead = Schema.Struct({
  value: Schema.NullOr(BanneretMap),
  fetchedAt: Schema.NullOr(Schema.String),
  atWork: Schema.Array(Schema.String),
  restsOn: Schema.Boolean,
  checked: Schema.Boolean,
  problem: Schema.optional(Schema.Struct({ message: Schema.String, since: Schema.String })),
});
export type BanneretFeedMapRead = typeof BanneretFeedMapRead.Type;

/** One of a person's machines, from the relay's `machines` file. Revoked machines are left out. */
export const BanneretTeamMachine = Schema.Struct({
  lastHeardAt: Schema.optional(Schema.String),
  poolHostId: Schema.optional(Schema.String),
  id: Schema.String,
  label: Schema.String,
  /** Open: `laptop`, `desktop`, `server`, `cloud`. */
  kind: Schema.String,
  connected: Schema.Boolean,
});
export type BanneretTeamMachine = typeof BanneretTeamMachine.Type;

/**
 * One live agent session (relay-v1 `TeamSession`). `state` is open: `working`, `waiting`, `idle`,
 * `not_heard_from` are known. `since` is when it entered that state. `parentId` names its orchestrator.
 */
export const BanneretTeamSession = Schema.Struct({
  stopReason: Schema.optional(Schema.String),
  id: Schema.String,
  parentId: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  provider: Schema.String,
  state: Schema.String,
  waiting: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  since: Schema.String,
});
export type BanneretTeamSession = typeof BanneretTeamSession.Type;

export const OfficeCounts = Schema.Struct({
  working: Schema.Number,
  waiting: Schema.Number,
  idle: Schema.Number,
  notHeardFrom: Schema.Number,
  stopped: Schema.Number,
});
const OfficeAgent = Schema.Struct({
  personId: Schema.String,
  counts: OfficeCounts,
  rooms: Schema.Array(Schema.Struct({ board: Schema.String, waiting: Schema.Number })),
});
export const OfficeAgentPage = Schema.Struct({
  agents: Schema.Array(OfficeAgent),
  nextCursor: Schema.NullOr(Schema.String),
});
export const OfficeRoomPage = Schema.Struct({
  sessions: Schema.Array(Schema.Struct({ ...BanneretTeamSession.fields, personId: Schema.String })),
  nextCursor: Schema.NullOr(Schema.String),
});
export const OfficeSummary = Schema.Struct({
  rooms: Schema.Array(
    Schema.Struct({
      board: Schema.String,
      counts: OfficeCounts,
      desks: Schema.Number,
      active: Schema.Number,
      meetingUrl: Schema.optional(Schema.String),
    }),
  ),
  agents: Schema.Array(OfficeAgent),
  agentsNextCursor: Schema.NullOr(Schema.String),
  office: Schema.Struct({ meetingUrl: Schema.optional(Schema.String) }),
  hallway: Schema.Struct({ counts: OfficeCounts }),
  people: Schema.Struct({ total: Schema.Number }),
});
export const OfficeDirectory = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      login: Schema.String,
      role: Schema.String,
      displayName: Schema.optional(Schema.String),
      presence: Schema.Literals(["available", "focusing", "away", "off"]),
      status: Schema.optional(Schema.Struct({ text: Schema.String })),
      seatBoard: Schema.optional(Schema.String),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export type OfficeRoomPage = typeof OfficeRoomPage.Type;
export type OfficeAgentPage = typeof OfficeAgentPage.Type;
export type OfficeSummary = typeof OfficeSummary.Type;

/** One person: their role, their machines and their live sessions. */
export const BanneretTeamPerson = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  /** Open: `founder`, `limited_staff`. */
  role: Schema.String,
  machines: Schema.Array(BanneretTeamMachine),
  sessions: Schema.Array(BanneretTeamSession),
});
export type BanneretTeamPerson = typeof BanneretTeamPerson.Type;

/** The Team directory joined with room sessions and visible machines, in the relay's (login) order. */
export const BanneretTeam = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({
      ...BanneretTeamPerson.fields,
      displayName: Schema.optional(Schema.String),
      presence: Schema.optional(Schema.String),
      status: Schema.optional(Schema.Struct({ text: Schema.String })),
      seatBoard: Schema.optional(Schema.String),
    }),
  ),
  office: Schema.optional(
    Schema.Struct({
      summary: OfficeSummary,
      preset: Schema.Literals(["company", "community"]),
      revision: Schema.String,
      files: Schema.Record(Schema.String, Schema.String),
      flags: Schema.Array(Schema.String),
    }),
  ),
});
export type BanneretTeam = typeof BanneretTeam.Type;

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
export const BanneretTeamRead = snapshotRead(BanneretTeam);
export type BanneretTeamRead = typeof BanneretTeamRead.Type;

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
  dashboards: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        url: Schema.String,
        group: Schema.optional(Schema.String),
      }),
    ),
  ),
  leaseClocks: Schema.optional(
    Schema.Struct({ staleSeconds: Schema.Number, expirySeconds: Schema.Number }),
  ),
  /** The section kinds the relay advertises. */
  sections: Schema.Array(Schema.String),
  /** The open needs-you count from the last `needs.changed`, if one arrived. */
  needsCount: Schema.NullOr(Schema.Number),
  boardChannels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  chatFlags: Schema.optional(Schema.Array(Schema.String)),
  chatNotice: Schema.optional(ChatNotice),
  chatRevision: Schema.optional(Schema.Number),
  revision: Schema.Number,
  /** Null while the relay advertises no board section, or before it was looked at. */
  board: Schema.NullOr(BanneretFeedBoardRead),
  /** Null while the relay advertises no map section, or before it was looked at. */
  map: Schema.NullOr(BanneretFeedMapRead),
  /** Null while the relay advertises no feed section, or before it was looked at. */
  feed: Schema.NullOr(BanneretFeedEntriesRead),
  /** Null while the feed section lacks the `graveyard` flag, or before it was looked at. */
  graveyard: Schema.NullOr(BanneretGraveyardRead),
  /** Null while the relay advertises no team section, or before it was looked at. */
  team: Schema.NullOr(BanneretTeamRead),
});
export type BanneretFeedState = typeof BanneretFeedState.Type;

const WsBanneretRelayTodayRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.today, {
  /** Device-local shipped cutoff. */
  payload: Schema.Struct({ relayOrigin: Schema.String, since: Schema.optional(Schema.String) }),
  success: BanneretFeedTodayRead,
  error: EnvironmentAuthorizationError,
});

const WsBanneretRelayNeedsRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.needs, {
  payload: Schema.Struct({ relayOrigin: Schema.String, cursor: Schema.optional(Schema.String) }),
  success: BanneretFeedNeedsRead,
  error: EnvironmentAuthorizationError,
});

const WsBanneretRelayFeedRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.feed, {
  payload: Schema.Struct({ relayOrigin: Schema.String }),
  success: BanneretFeedState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsBanneretRelayFeedPageRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.feedPage, {
  /** The `nextCursor` of the feed file or of the previous page. */
  payload: Schema.Struct({ relayOrigin: Schema.String, cursor: Schema.String }),
  success: BanneretFeedEntryPageRead,
  error: EnvironmentAuthorizationError,
});

const WsBanneretRelayGraveyardPageRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.graveyardPage, {
  payload: Schema.Struct({ relayOrigin: Schema.String, cursor: Schema.String }),
  success: BanneretGraveyardPageRead,
  error: EnvironmentAuthorizationError,
});

const WsBanneretRelayTaskRpc = Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.task, {
  payload: Schema.Struct({ relayOrigin: Schema.String, taskId: Schema.String }),
  success: BanneretTaskRead,
  error: EnvironmentAuthorizationError,
});

export const BANNERET_RELAY_FEED_RPCS = [
  Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.chat, {
    payload: Schema.Struct({ relayOrigin: Schema.String, action: ChannelAction }),
    success: ChannelResult,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.room, {
    payload: Schema.Struct({
      relayOrigin: Schema.String,
      board: Schema.NullOr(Schema.String),
      cursor: Schema.optional(Schema.String),
    }),
    success: Schema.NullOr(OfficeRoomPage),
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(BANNERET_RELAY_FEED_WS_METHODS.agents, {
    payload: Schema.Struct({ relayOrigin: Schema.String, cursor: Schema.String }),
    success: Schema.NullOr(OfficeAgentPage),
    error: EnvironmentAuthorizationError,
  }),
  WsBanneretRelayTodayRpc,
  WsBanneretRelayNeedsRpc,
  WsBanneretRelayFeedRpc,
  WsBanneretRelayFeedPageRpc,
  WsBanneretRelayGraveyardPageRpc,
  WsBanneretRelayTaskRpc,
] as const;

export const BANNERET_RELAY_FEED_RPC_SCOPES = {
  [BANNERET_RELAY_FEED_WS_METHODS.chat]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.today]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.agents]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.room]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.needs]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.feed]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.feedPage]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.graveyardPage]: AuthOrchestrationOperateScope,
  [BANNERET_RELAY_FEED_WS_METHODS.task]: AuthOrchestrationOperateScope,
} as const;

export const BANNERET_RELAY_FEED_RPC_AGGREGATES = {
  [BANNERET_RELAY_FEED_WS_METHODS.chat]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.today]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.agents]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.room]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.needs]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.feed]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.feedPage]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.graveyardPage]: "banneret-relay",
  [BANNERET_RELAY_FEED_WS_METHODS.task]: "banneret-relay",
} as const;
