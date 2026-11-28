// @effect-diagnostics globalFetch:off globalFetchInEffect:off - the relay's event stream is one long-lived fetch; redirects, connect and idle time are capped here.
// Banneret Hub: Today, Needs you, the board and the relay's event stream for an enrolled environment.
// One feed per relay this environment has an enrolment with, each with its own event stream and
// snapshot cache, open only while that relay's enrolment is `configured`; an environment that has
// not joined makes no relay call. Relay answers are reshaped field by field (relay strings
// stay plain data), and the last good answer is kept so a screen is never blank while the relay is
// away. The board, the map, the feed, the graveyard and the team come from the snapshot (Snapshot.ts), each read only
// when capabilities advertise the snapshot and its section; older feed and graveyard pages, and one
// task for the Task tab, are read on request.
import {
  BANNERET_RELAY_FEED_WS_METHODS,
  ChatNotice,
  ChatAsk,
  ChatRead,
  type ChannelAction,
  type ChannelResult,
  type BanneretEnrolmentView,
  type BanneretFeedBoardRead,
  type BanneretFeedDeepLink,
  type BanneretFeedEntriesRead,
  type BanneretFeedEntryPage,
  type BanneretFeedEntryPageRead,
  type BanneretFeedMapRead,
  type BanneretGraveyardPage,
  type BanneretGraveyardPageRead,
  type BanneretGraveyardRead,
  type BanneretFeedState,
  type BanneretFeedNeedsItem,
  type BanneretFeedNeedsPage,
  type BanneretFeedNeedsRead,
  type BanneretFeedNotMeasured,
  type BanneretFeedToday,
  type BanneretFeedTodayRead,
  type BanneretTaskRead,
  OfficeAgentPage,
  OfficeRoomPage,
  OfficeSummary,
  OfficeDirectory,
  type BanneretTeamRead,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { makeHandoffs } from "../chat/Handoffs.ts";
import { makeDeliveries } from "../chat/Deliveries.ts";
import { postReview } from "../chat/PostReview.ts";
import { promote } from "../chat/Promote.ts";
import { SourceControlDrivers } from "../../sourceControl/builtInDrivers.ts";
import type { SourceControlDriverInstance } from "@t3tools/source-control-core/server/driver";
import { catchUpChat, channelAction, chatUnavailable } from "./ChatSync.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { BanneretEnrolment, type RelayEnrolment } from "./Enrolment.ts";
import { RelayCallError, type RelayReply } from "./RelayClient.ts";
import {
  boardTaskIndex,
  boardTaskRef,
  liveTaskIds,
  makeSnapshotReader,
  boardHeadKeys,
  reshapeBoards,
  reshapeMap,
  reshapeFeedPage,
  reshapeGraveyardPage,
  reshapeTask,
  machinesByOwner,
  unquoteEtag,
} from "./Snapshot.ts";

export interface RelayFeedOptions {
  /** First reconnect delay; it doubles up to `maxRetryMs`. */
  readonly retryMs: number;
  readonly maxRetryMs: number;
  /** The relay comments every 25 s; a stream silent for this long is reopened. */
  readonly idleMs: number;
  readonly connectMs: number;
  /** How often machine labels for deep links may be reread. */
  readonly machinesRefreshMs: number;
  /** How often the snapshot head is reread without a hint from the heartbeat. */
  readonly snapshotPollMs: number;
}

const decodeOfficeDirectory = Schema.decodeUnknownOption(OfficeDirectory);
const decodeOfficeSummary = Schema.decodeUnknownOption(OfficeSummary);
const decodeOfficeAgentPage = Schema.decodeUnknownOption(OfficeAgentPage);
const decodeOfficeRoomPage = Schema.decodeUnknownOption(OfficeRoomPage);
const DEFAULT_OPTIONS: RelayFeedOptions = {
  retryMs: 2000,
  maxRetryMs: 60_000,
  idleMs: 75_000,
  connectMs: 10_000,
  machinesRefreshMs: 60_000,
  snapshotPollMs: 60_000,
};

/** One relay's feed. */
interface RelayFeedInstance {
  readonly agents: (cursor: string) => Effect.Effect<OfficeAgentPage | null>;
  readonly room: (
    board: string | null,
    cursor?: string | undefined,
  ) => Effect.Effect<OfficeRoomPage | null>;
  readonly chat: (action: ChannelAction) => Effect.Effect<ChannelResult>;
  readonly today: (since?: string) => Effect.Effect<BanneretFeedTodayRead>;
  readonly needs: (cursor: string | undefined) => Effect.Effect<BanneretFeedNeedsRead>;
  /** An older feed page, from a `nextCursor`. */
  readonly feedPage: (cursor: string) => Effect.Effect<BanneretFeedEntryPageRead>;
  /** An older graveyard page, from a `nextCursor`. */
  readonly graveyardPage: (cursor: string) => Effect.Effect<BanneretGraveyardPageRead>;
  /** One task with its preview and sign-off; `notFound` when the relay does not know it. */
  readonly task: (taskId: string) => Effect.Effect<BanneretTaskRead>;
  readonly events: Stream.Stream<BanneretFeedState>;
  /** The capabilities `mcpTools`, as last read; null until capabilities have been read. */
  readonly mcpTools: Effect.Effect<ReadonlyArray<RelayMcpTool> | null>;
}

/** One capabilities `mcpTools` entry as the Hub keeps it: the name and optional permission for the caller. */
export interface RelayMcpTool {
  readonly name: string;
  readonly requires?: string;
}

/** Every call names its relay; a relay this environment has no enrolment with answers as not joined. */
interface FeedService {
  readonly agents: (origin: string, cursor: string) => Effect.Effect<OfficeAgentPage | null>;
  readonly room: (
    origin: string,
    board: string | null,
    cursor?: string | undefined,
  ) => Effect.Effect<OfficeRoomPage | null>;
  readonly chat: (origin: string, action: ChannelAction) => Effect.Effect<ChannelResult>;
  readonly today: (relayOrigin: string, since?: string) => Effect.Effect<BanneretFeedTodayRead>;
  readonly needs: (
    relayOrigin: string,
    cursor: string | undefined,
  ) => Effect.Effect<BanneretFeedNeedsRead>;
  readonly feedPage: (
    relayOrigin: string,
    cursor: string,
  ) => Effect.Effect<BanneretFeedEntryPageRead>;
  readonly graveyardPage: (
    relayOrigin: string,
    cursor: string,
  ) => Effect.Effect<BanneretGraveyardPageRead>;
  readonly task: (relayOrigin: string, taskId: string) => Effect.Effect<BanneretTaskRead>;
  readonly events: (relayOrigin: string) => Stream.Stream<BanneretFeedState>;
  /** Server only, for the agent toolkit; null for a relay not joined or whose capabilities are unread. */
  readonly mcpTools: (relayOrigin: string) => Effect.Effect<ReadonlyArray<RelayMcpTool> | null>;
}

const NOT_JOINED = { joined: false, value: null, fetchedAt: null } as const;
const NOT_JOINED_SNAPSHOT: BanneretFeedState = {
  joined: false,
  live: false,
  since: null,
  sectionsKnown: false,
  sections: [],
  needsCount: null,
  revision: 0,
  board: null,
  map: null,
  feed: null,
  graveyard: null,
  team: null,
};

/** A reference, so a server built without the feed layer answers as an environment that never joined. */
export class BanneretRelayFeed extends Context.Reference<FeedService>(
  "t3/banneret/relay/RelayFeed/BanneretRelayFeed",
  {
    defaultValue: () => ({
      room: () => Effect.succeed(null),
      agents: () => Effect.succeed(null),
      chat: () => Effect.succeed(chatUnavailable),
      today: () => Effect.succeed(NOT_JOINED),
      needs: () => Effect.succeed(NOT_JOINED),
      feedPage: () => Effect.succeed(NOT_JOINED),
      graveyardPage: () => Effect.succeed(NOT_JOINED),
      task: () => Effect.succeed(NOT_JOINED),
      events: () => Stream.concat(Stream.make(NOT_JOINED_SNAPSHOT), Stream.never),
      mcpTools: () => Effect.succeed(null),
    }),
  },
) {}

type Fields = Readonly<Record<string, unknown>>;
type Problem = { readonly message: string; readonly since: string };
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

/** The pull request behind a shipped item: `{number, url, repo}`, all required. */
const shippedPr = (value: unknown) => {
  const source = fields(value);
  const number = source?.number;
  const url = text(source?.url, 2048);
  const repo = text(source?.repo, 200);
  return typeof number === "number" &&
    Number.isInteger(number) &&
    url !== undefined &&
    repo !== undefined
    ? { number, url, repo }
    : undefined;
};

// A stuck item has a task or a subject, never both; the task wins if a relay sends both. A subject
// needs a repo or a job.
const stuckSubject = (value: unknown) => {
  const source = fields(value);
  const repo = text(source?.repo, 200);
  const job = fields(source?.job);
  const jobName = text(job?.name, 200);
  if (repo === undefined && jobName === undefined) return undefined;
  const run = fields(source?.run);
  const runName = text(run?.name, 200);
  const runUrl = text(run?.url, 2048);
  const jobUrl = text(job?.url, 2048);
  return {
    ...optional("repo", repo),
    ...(runName === undefined || runUrl === undefined
      ? {}
      : { run: { name: runName, url: runUrl } }),
    ...(jobName === undefined
      ? {}
      : { job: { name: jobName, ...(jobUrl === undefined ? {} : { url: jobUrl }) } }),
  };
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

const isChatAsk = Schema.is(ChatAsk);
const isChatRead = Schema.is(ChatRead);
const isChatNotice = Schema.is(ChatNotice);
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
    ...(typeof source?.count === "number" &&
      Number.isInteger(source.count) &&
      source.count > 0 && { count: source.count }),
    ...optional("handoffId", text(source?.handoffId, 64)),
    ...(source?.step === "waiting_release" || source?.step === "waiting_take"
      ? { step: source.step }
      : {}),
    ...optional("conversationId", text(source?.conversationId, 64)),
    ...optional("handleId", text(source?.handleId, 64)),
    ...(isChatAsk(source?.ask) ? { ask: source.ask } : {}),
    ...(isChatRead(source?.chatRead) ? { chatRead: source.chatRead } : {}),
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
    : {
        source: sourceName,
        reason,
        since,
        ...optional("kind", text(source?.kind, 32)),
        ...optional("detail", text(source?.detail, 240)),
      };
};

const block = <T>(value: unknown, item: (value: unknown) => T | undefined) => {
  const source = fields(value);
  return {
    state: text(source?.state, 32) ?? "not_measured",
    items: defined(list(source?.items, 20).map(item)),
    notMeasured: defined(list(source?.notMeasured, 32).map(notMeasured)),
  };
};

export const reshapeToday = (body: unknown, labelFor: LabelFor): BanneretFeedToday | undefined => {
  const source = fields(body);
  const generatedAt = text(source?.generatedAt, 64);
  if (generatedAt === undefined) return undefined;
  const needsYou = fields(source?.needsYou);
  return {
    generatedAt,
    needsYou: {
      ...block(needsYou, (item) => needsItem(item, labelFor)),
      nextCursor: text(needsYou?.nextCursor, 1024) ?? null,
    },
    shipped: block(source?.shipped, (value) => {
      const item = fields(value);
      const shippedTask = task(item?.task);
      const pr = shippedPr(item?.pr);
      const summary = text(item?.summary, 300);
      const mergedAt = text(item?.mergedAt, 64);
      const live = text(item?.live, 32);
      return shippedTask === undefined ||
        pr === undefined ||
        summary === undefined ||
        mergedAt === undefined ||
        live === undefined
        ? undefined
        : {
            task: shippedTask,
            pr,
            ...optional("ref", boardTaskRef(item?.ref)),
            summary,
            mergedAt,
            live,
          };
    }),
    working: block(source?.working, (value) => {
      const item = fields(value);
      const who = person(item?.person);
      if (who === undefined) return undefined;
      return {
        person: who,
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
      const rules = [
        ...new Set(
          list(item?.rules, 16).flatMap((rule) => {
            const name = text(rule, 64);
            return name === undefined ? [] : [name];
          }),
        ),
      ];
      const since = text(item?.since, 64);
      if (rules.length === 0 || since === undefined) return undefined;
      const stuckTask = task(item?.task);
      return {
        rules,
        since,
        ...optional("task", stuckTask),
        ...optional("subject", stuckTask === undefined ? stuckSubject(item?.subject) : undefined),
        ...optional("owner", person(item?.owner)),
        ...optional("deepLink", deepLink(item?.deepLink, labelFor)),
      };
    }),
    ...optional(
      "health",
      !fields(source?.health)
        ? undefined
        : {
            alarms: defined(
              list(fields(source?.health)?.alarms, 100).map((value) => {
                const a = fields(value);
                const id = text(a?.id, 64),
                  sourceId = text(a?.sourceId, 64),
                  title = text(a?.title, 300),
                  firedAt = text(a?.firedAt, 64);
                const severity = a?.severity;
                if (
                  !id ||
                  !sourceId ||
                  !title ||
                  !firedAt ||
                  a?.resolvedAt !== undefined ||
                  (severity !== "warning" && severity !== "critical" && severity !== "info")
                )
                  return undefined;
                return {
                  id,
                  sourceId,
                  title,
                  firedAt,
                  severity,
                  ...optional("detail", text(a?.detail, 500)),
                  ...optional("url", text(a?.url, 2048)),
                } as const;
              }),
            ),
            ...block(source?.health, (value) => {
              const item = fields(value);
              const id = text(item?.id, 64);
              const label = text(item?.label, 120);
              const state = text(item?.state, 32);
              const sourceId = text(item?.source, 64),
                kind = text(item?.kind, 32);
              if (
                !sourceId ||
                !kind ||
                id === undefined ||
                label === undefined ||
                state === undefined
              )
                return undefined;
              return {
                id,
                label,
                state,
                source: sourceId,
                kind,
                observedAt: text(item?.observedAt, 64) ?? null,
                ...optional("summary", text(item?.summary, 300)),
              };
            }),
          },
    ),
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
  defined(
    list(fields(body)?.sections, 64).map((section) => {
      const row = fields(section);
      return row?.kind === "team" && row.version !== 2 ? undefined : text(row?.kind, 32);
    }),
  );

const mcpToolsOf = (body: unknown): ReadonlyArray<RelayMcpTool> =>
  defined(
    list(fields(body)?.mcpTools, 256).map((entry) => {
      const name = text(fields(entry)?.name, 64);
      const required = fields(entry)?.requires;
      const permission = text(required, 64);
      return name === undefined || (required !== undefined && !permission)
        ? undefined
        : { name, ...(permission && { requires: permission }) };
    }),
  );

/** The flags of the first section of `kind`, or null when the relay does not advertise one. */
const sectionFlags = (body: unknown, kind: string): ReadonlyArray<string> | null => {
  const section = list(fields(body)?.sections, 64)
    .map(fields)
    .find((candidate) => candidate?.kind === kind && (kind !== "team" || candidate.version === 2));
  return section === undefined
    ? null
    : defined(list(section.flags, 32).map((flag) => text(flag, 64)));
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

const makeRelayFeed = Effect.fn("BanneretRelayFeed.makeRelayFeed")(function* (
  enrolment: RelayEnrolment,
  environmentId: string,
  options: RelayFeedOptions,
  /** The layer's scope: a feed added while a request runs must outlive that request. */
  layerScope: Scope.Scope,
  agents?: Effect.Success<typeof makeDeliveries>,
  github?: SourceControlDriverInstance,
  handoffs?: Effect.Success<typeof makeHandoffs>,
) {
  const changes = yield* PubSub.unbounded<BanneretFeedState>();
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
  let sectionsKnown = false;
  let dashboardSettings: Pick<BanneretFeedState, "dashboards" | "leaseClocks"> = {};
  let mcpTools: ReadonlyArray<RelayMcpTool> = [];
  // The `ETag` of the capabilities last read: a heartbeat whose `capabilitiesVersion` differs means
  // the document changed, even when the stream missed `capabilities.changed` or the read failed.
  let sectionsVersion: string | undefined;
  // Never reset, so a client can tell any two states apart.
  let chatFlags: ReadonlyArray<string> = [];
  let chatSeq = 0;
  let boardChannels: Record<string, string> = {};
  let chatRevision = 0;
  let revision = 0;
  let needsCount: number | null = null;
  let today: {
    readonly since: string | undefined;
    readonly value: BanneretFeedToday;
    readonly fetchedAt: string;
  } | null = null;
  let needsFirst: { readonly value: BanneretFeedNeedsPage; readonly fetchedAt: string } | null =
    null;
  let problem: { readonly message: string; readonly since: string } | null = null;
  // The board: its section's flags (null when not advertised), whether capabilities carry the
  // snapshot, the last read and what it was built from, and the hint last seen in a heartbeat.
  let boardFlags: ReadonlyArray<string> | null = null;
  let snapshotOffered = false;
  let board: BanneretFeedBoardRead | null = null;
  let boardSignature = "";
  // The map: its section's flags (null when not advertised), the last read and what it was built from.
  let mapFlags: ReadonlyArray<string> | null = null;
  let mapRead: BanneretFeedMapRead | null = null;
  let mapSignature = "";
  // The feed and graveyard: the feed section's flags (null when not advertised), each last read and
  // the file hash it was built from.
  let feedFlags: ReadonlyArray<string> | null = null;
  let feedRead: BanneretFeedEntriesRead | null = null;
  let feedSignature = "";
  let graveyardRead: BanneretGraveyardRead | null = null;
  let graveyardSignature = "";
  // The team: its section's flags (null when not advertised), the last read and the view it was built
  // from. The machines file changes on every heartbeat, so the view itself is the signature.
  let teamPreset: "company" | "community" = "community";
  let teamFlags: ReadonlyArray<string> | null = null;
  let teamRead: BanneretTeamRead | null = null;
  let teamSignature = "";
  let lastHint: string | undefined;
  let snapshotWake: Queue.Queue<void> | undefined;
  let snapshotReader: ReturnType<typeof makeSnapshotReader> | undefined;
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

  const snapshot = (): BanneretFeedState => ({
    joined: joined !== null,
    live,
    since,
    ...dashboardSettings,
    sectionsKnown,
    sections,
    needsCount,
    ...(sections.includes("chat") ? { chatRevision, chatFlags, boardChannels } : {}),
    revision,
    board,
    map: mapRead,
    feed: feedRead,
    graveyard: graveyardRead,
    team: teamRead,
  });
  const publishSnapshot = Effect.suspend(() => PubSub.publish(changes, snapshot()));
  /** Today or Needs you may have changed: clients refetch. */
  const bump = Effect.suspend(() => {
    revision += 1;
    return publishSnapshot;
  });

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

  const readToday = Effect.fn("BanneretRelayFeed.today")(function* (since?: string) {
    yield* adopt(joinedOf(yield* enrolment.status));
    const outcome = yield* read(
      since === undefined
        ? "/relay/v1/today"
        : `/relay/v1/today?since=${encodeURIComponent(since)}`,
      reshapeToday,
    );
    if (outcome.ok) {
      if (stillJoined(outcome.key))
        today = { since, value: outcome.value, fetchedAt: outcome.fetchedAt };
      return { joined: true, value: outcome.value, fetchedAt: outcome.fetchedAt };
    }
    if (!outcome.joined) return NOT_JOINED;
    return {
      joined: true,
      value: today?.since === since ? (today?.value ?? null) : null,
      fetchedAt: today?.since === since ? (today?.fetchedAt ?? null) : null,
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
          chatFlags = sectionFlags(reply.body, "chat") ?? [];
          boardChannels = Object.fromEntries(
            list(fields(fields(reply.body)?.chat)?.boards, 50).flatMap((entry) => {
              const row = fields(entry);
              const board = text(row?.board, 128);
              const channel = text(row?.channel, 128);
              return board && channel ? [[board, channel]] : [];
            }),
          );
          sectionsKnown = true;
          const dashboards = defined(
            list(fields(reply.body)?.dashboards, 32).map((value) => {
              const d = fields(value);
              const id = text(d?.id, 64),
                title = text(d?.title, 120),
                url = text(d?.url, 2048);
              if (!id || !title || !url || !URL.canParse(url) || new URL(url).protocol !== "https:")
                return undefined;
              return { id, title, url, ...optional("group", text(d?.group, 80)) };
            }),
          );
          const boardSection = list(fields(reply.body)?.sections, 64)
            .map(fields)
            .find((s) => s?.kind === "board");
          const params = fields(boardSection?.params);
          const staleSeconds = params?.staleSeconds,
            expirySeconds = params?.expirySeconds;
          const clocks =
            typeof staleSeconds === "number" &&
            Number.isSafeInteger(staleSeconds) &&
            staleSeconds > 0 &&
            typeof expirySeconds === "number" &&
            Number.isSafeInteger(expirySeconds) &&
            expirySeconds > staleSeconds
              ? { staleSeconds, expirySeconds }
              : undefined;
          dashboardSettings = { dashboards, ...optional("leaseClocks", clocks) };
          sectionsVersion = reply.etag;
          mcpTools = mcpToolsOf(reply.body);
          boardFlags = sectionFlags(reply.body, "board");
          mapFlags = sectionFlags(reply.body, "map");
          feedFlags = sectionFlags(reply.body, "feed");
          teamFlags = sectionFlags(reply.body, "team");
          teamPreset =
            fields(fields(reply.body)?.team)?.preset === "company" ? "company" : "community";
          snapshotOffered = fields(reply.body)?.snapshot !== undefined;
          wakeSnapshot();
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

  const syncChat = Effect.fn("RelayFeed.syncChat")(function* (key: string, inline?: number) {
    if (!sections.includes("chat") || !stillJoined(key)) return;
    const next = inline === chatSeq + 1 ? inline : yield* catchUpChat(enrolment, chatSeq);
    if (!stillJoined(key)) return;
    chatSeq = next;
    chatRevision++;
    yield* publishSnapshot;
  });

  const syncAgents = Effect.suspend(() =>
    agents && joined && chatFlags.includes("agents") ? agents.reconcile(enrolment) : Effect.void,
  );
  const handleMessage = Effect.fn("BanneretRelayFeed.handleMessage")(function* (
    key: string,
    message: SseMessage,
  ) {
    if (!stillJoined(key)) return;
    if (message.id !== undefined && message.id !== "") lastEventId = message.id;
    const data = parseData(message.data);
    switch (message.event) {
      // Live eligible create -> one transient notice; subscribe, reconnect, restart -> snapshot without notices.
      case "chat.delivery":
        yield* syncAgents;
        return;
      case "chat.changed":
        if (agents && chatFlags.includes("agent_asks")) yield* agents.changed(enrolment);
        if (sections.includes("chat") && typeof data?.seq === "number" && isChatNotice(data.notice))
          yield* PubSub.publish(changes, { ...snapshot(), chatNotice: data.notice });
        yield* syncChat(key, typeof data?.seq === "number" && data.change ? data.seq : undefined);
        return;
      case "needs.changed": {
        const count = data?.count;
        if (typeof count === "number" && Number.isInteger(count) && count >= 0) needsCount = count;
        wakeSnapshot();
        yield* bump;
        return;
      }
      case "team.changed":
      case "team.rooms_changed":
        wakeSnapshot();
        return;
      case "mention":
        yield* bump;
        return;
      case "roles.changed":
        chatRevision++;
        yield* refreshSections(key);
        return;
      case "capabilities.changed":
        yield* refreshSections(key);
        return;
      case "reset":
        // The relay cannot replay what this server missed: refetch everything.
        needsCount = null;
        yield* refreshSections(key);
        yield* syncAgents;
        yield* syncChat(key);
        wakeSnapshot();
        yield* bump;
        return;
      default:
        // bundle.changed and staff.removed belong to other parts of the Hub; unknown events are ignored.
        return;
    }
  });

  /** One connection: open, read until it ends or goes quiet. Fails with the reason it stopped. */
  const connectOnce = Effect.fn("BanneretRelayFeed.connectOnce")(function* (
    key: string,
    opened: Effect.Effect<void, RelayCallError>,
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

  const wakeSnapshot = () => {
    if (snapshotWake !== undefined) Queue.offerUnsafe(snapshotWake, undefined);
  };

  /**
   * Rereads the snapshot head (and any changed file) for each surface whose section the relay
   * advertises: the board and the map (each with the work file for the ring), the feed and the
   * graveyard. A surface
   * whose section went away is dropped. Publishes once, and only when a surface or a problem changed.
   */
  const refreshSnapshot = Effect.fn("BanneretRelayFeed.refreshSnapshot")(function* (
    key: string,
    reader: ReturnType<typeof makeSnapshotReader>,
  ) {
    const current = joined;
    if (!stillJoined(key) || current === null || !sectionsKnown) return;
    const graveyardOffered = feedFlags?.includes("graveyard") === true;
    const leases = boardFlags?.includes("leases") === true;
    const checked = boardFlags?.includes("checked") === true;
    const restsOn = mapFlags?.includes("rests_on") === true;
    // The sign-off rule is flagged on the board section; a relay may flag the map too.
    const mapChecked = checked || mapFlags?.includes("checked") === true;
    let changed = false;
    let boardChanged = false;
    if (boardFlags === null) {
      boardSignature = "";
      if (board !== null) {
        board = null;
        changed = boardChanged = true;
      }
    }
    if (mapFlags === null) {
      mapSignature = "";
      if (mapRead !== null) {
        mapRead = null;
        changed = true;
      }
    }
    if (feedFlags === null) {
      feedSignature = "";
      if (feedRead !== null) {
        feedRead = null;
        changed = true;
      }
    }
    if (!graveyardOffered) {
      graveyardSignature = "";
      if (graveyardRead !== null) {
        graveyardRead = null;
        changed = true;
      }
    }
    if (teamFlags === null) {
      teamSignature = "";
      if (teamRead !== null) {
        teamRead = null;
        changed = true;
      }
    }
    const fixed = [
      ...(mapFlags === null ? [] : ["map"]),
      ...(boardFlags === null && mapFlags === null ? [] : ["work"]),
      ...(feedFlags === null ? [] : ["feed"]),
      ...(graveyardOffered ? ["graveyard"] : []),
      ...(teamFlags === null ? [] : ["team", "team.people", "machines"]),
    ];
    const wantsAny = boardFlags !== null || fixed.length > 0;
    // The boards index and every `board.<id>` the head names; chosen per head read.
    const wanted = (keys: ReadonlyArray<string>) => [
      ...(boardFlags === null ? [] : boardHeadKeys(keys)),
      ...fixed,
    ];
    const at = yield* nowIso;
    const notPublished = (what: string) =>
      `${current.displayName} does not publish its ${what} yet.`;
    const unreadable = problemMessage(badResponse(200), current.displayName);
    const problemOn = <R extends { readonly problem?: Problem | undefined }>(
      read: R,
      message: string,
    ): R => ({ ...read, problem: { message, since: read.problem?.since ?? at } });
    const boardProblem = (message: string) => {
      if (
        boardFlags === null ||
        (board?.problem?.message === message &&
          board.leases === leases &&
          board.checked === checked)
      ) {
        return;
      }
      const base: BanneretFeedBoardRead = {
        ...(board ?? { value: null, fetchedAt: null, atWork: [] }),
        leases,
        checked,
      };
      board = problemOn(base, message);
      changed = true;
    };
    const mapProblem = (message: string) => {
      if (
        mapFlags === null ||
        (mapRead?.problem?.message === message &&
          mapRead.restsOn === restsOn &&
          mapRead.checked === mapChecked)
      ) {
        return;
      }
      const base: BanneretFeedMapRead = {
        ...(mapRead ?? { value: null, fetchedAt: null, atWork: [] }),
        restsOn,
        checked: mapChecked,
      };
      mapRead = problemOn(base, message);
      changed = true;
    };
    const feedProblem = (message: string) => {
      if (feedFlags === null || feedRead?.problem?.message === message) return;
      feedRead = problemOn(feedRead ?? { value: null, fetchedAt: null }, message);
      changed = true;
    };
    const graveyardProblem = (message: string) => {
      if (!graveyardOffered || graveyardRead?.problem?.message === message) return;
      graveyardRead = problemOn(graveyardRead ?? { value: null, fetchedAt: null }, message);
      changed = true;
    };
    const teamProblem = (message: string) => {
      if (teamFlags === null || teamRead?.problem?.message === message) return;
      teamRead = problemOn(teamRead ?? { value: null, fetchedAt: null }, message);
      changed = true;
    };

    if (wantsAny && !snapshotOffered) {
      boardProblem(notPublished("board"));
      mapProblem(notPublished("build map"));
      feedProblem(notPublished("feed"));
      graveyardProblem(notPublished("graveyard"));
      teamProblem(notPublished("team"));
    } else if (wantsAny) {
      const outcome = yield* reader.read(wanted).pipe(Effect.result);
      if (!stillJoined(key)) return;
      if (Result.isFailure(outcome)) {
        if (outcome.failure.code === "not_configured") return;
        const message = problemMessage(outcome.failure, current.displayName);
        boardProblem(message);
        mapProblem(message);
        feedProblem(message);
        graveyardProblem(message);
        teamProblem(message);
      } else {
        const { refs, files } = outcome.success;
        if (boardFlags !== null) {
          const value = refs.boards === undefined ? undefined : reshapeBoards(files.boards, files);
          if (refs.boards === undefined) boardProblem(notPublished("boards"));
          else if (value === undefined) boardProblem(unreadable);
          else {
            const atWork = files.work === undefined ? [] : liveTaskIds(files.work);
            // Every board file's hash: a change on one board republishes, an unchanged read does not.
            const boardRefs = boardHeadKeys(Object.keys(refs))
              .map((key) => `${key}=${refs[key]}`)
              .toSorted()
              .join(",");
            // The work file changes on every heartbeat; only the ring it yields counts.
            const signature = `${boardRefs} ${atWork.join(",")} ${leases} ${checked}`;
            if (signature === boardSignature && board !== null && board.problem === undefined) {
              // Unchanged: keep the newer age for the next publish without sending it again.
              board = { ...board, fetchedAt: at };
            } else {
              boardSignature = signature;
              board = { value, fetchedAt: at, atWork, leases, checked };
              changed = boardChanged = true;
            }
          }
        }
        if (mapFlags !== null) {
          const value = refs.map === undefined ? undefined : reshapeMap(files.map);
          if (refs.map === undefined) mapProblem(notPublished("build map"));
          else if (value === undefined) mapProblem(unreadable);
          else {
            const tasks = new Set(defined(value.items.map((item) => item.task?.id)));
            const live = files.work === undefined ? [] : liveTaskIds(files.work);
            const atWork = live.filter((id) => tasks.has(id));
            // As for the board: the work file changes on every heartbeat; only the ring counts.
            const signature = `${refs.map} ${atWork.join(",")} ${restsOn} ${mapChecked}`;
            if (signature === mapSignature && mapRead !== null && mapRead.problem === undefined) {
              mapRead = { ...mapRead, fetchedAt: at };
            } else {
              mapSignature = signature;
              mapRead = { value, fetchedAt: at, atWork, restsOn, checked: mapChecked };
              changed = true;
            }
          }
        }
        if (feedFlags !== null) {
          const value = refs.feed === undefined ? undefined : reshapeFeedPage(files.feed);
          if (refs.feed === undefined) feedProblem(notPublished("feed"));
          else if (value === undefined) feedProblem(unreadable);
          else if (refs.feed === feedSignature && feedRead?.problem === undefined && feedRead) {
            feedRead = { ...feedRead, fetchedAt: at };
          } else {
            feedSignature = refs.feed;
            feedRead = { value, fetchedAt: at };
            changed = true;
          }
        }
        if (graveyardOffered) {
          const value =
            refs.graveyard === undefined ? undefined : reshapeGraveyardPage(files.graveyard);
          if (refs.graveyard === undefined) graveyardProblem(notPublished("graveyard"));
          else if (value === undefined) graveyardProblem(unreadable);
          else if (
            refs.graveyard === graveyardSignature &&
            graveyardRead?.problem === undefined &&
            graveyardRead
          ) {
            graveyardRead = { ...graveyardRead, fetchedAt: at };
          } else {
            graveyardSignature = refs.graveyard;
            graveyardRead = { value, fetchedAt: at };
            changed = true;
          }
        }
        if (teamFlags !== null) {
          const roomFiles = reader.roomRefs();
          const signature = [
            refs.team,
            refs["team.people"],
            refs.machines,
            ...Object.entries(roomFiles).flat(),
            teamPreset,
            ...teamFlags,
          ].join(" ");
          if (!refs.team) teamProblem(notPublished("team"));
          else if (signature === teamSignature && teamRead && !teamRead.problem)
            teamRead = { ...teamRead, fetchedAt: at };
          else {
            const summary = Option.getOrUndefined(decodeOfficeSummary(files.team));
            let directory = Option.getOrUndefined(decodeOfficeDirectory(files["team.people"]));
            const people = [...(directory?.people ?? [])];
            const seen = new Set<string>();
            while (directory?.nextCursor) {
              const cursor = directory.nextCursor;
              if (seen.has(cursor)) {
                directory = undefined;
                break;
              }
              seen.add(cursor);
              const reply = yield* enrolment
                .signedGet("/relay/v1/team/people?cursor=" + encodeURIComponent(cursor))
                .pipe(Effect.option);
              directory = Option.getOrUndefined(
                Option.flatMap(reply, (r) => decodeOfficeDirectory(r.body)),
              );
              if (directory) people.push(...directory.people);
            }
            if (!stillJoined(key)) return;
            if (!summary || !directory) teamProblem(unreadable);
            else {
              const machines = machinesByOwner(
                teamFlags.includes("sharing") ? files.machines : undefined,
              );
              teamRead = {
                value: {
                  people: people.map((p) => ({
                    ...p,
                    machines: machines.get(p.id) ?? [],
                    sessions: [],
                  })),
                  office: {
                    summary,
                    preset: teamPreset,
                    revision: refs.team,
                    files: roomFiles,
                    flags: teamFlags,
                  },
                },
                fetchedAt: at,
              };
              teamSignature = signature;
              changed = true;
            }
          }
        }
      }
    }
    if (boardChanged) {
      yield* enrolment.setBoardTasks(board?.value == null ? [] : boardTaskIndex(board.value));
    }
    if (changed) yield* publishSnapshot;
  });

  /**
   * An older feed or graveyard page, or one task. A failure says why without touching Today's
   * problem; with `notFound`, a 404 answers as the relay not knowing the thing asked for.
   */
  const readPage = Effect.fn("BanneretRelayFeed.page")(function* <T>(
    target: string,
    reshape: (body: unknown) => T | undefined,
    notFound = false,
  ) {
    yield* adopt(joinedOf(yield* enrolment.status));
    const current = joined;
    if (current === null) return NOT_JOINED;
    const outcome = yield* enrolment.signedGet(target).pipe(
      Effect.flatMap((reply) => {
        const value = reshape(reply.body);
        return value === undefined ? Effect.fail(badResponse(reply.status)) : Effect.succeed(value);
      }),
      Effect.result,
    );
    const at = yield* nowIso;
    if (Result.isFailure(outcome)) {
      if (outcome.failure.code === "not_configured" || !stillJoined(current.key)) return NOT_JOINED;
      if (notFound && outcome.failure.status === 404) {
        return { joined: true, value: null, fetchedAt: at, notFound: true };
      }
      return {
        joined: true,
        value: null,
        fetchedAt: null,
        problem: { message: problemMessage(outcome.failure, current.displayName), since: at },
      };
    }
    return { joined: true, value: outcome.success, fetchedAt: at };
  });

  const pageQuery = (cursor: string) => `?limit=100&cursor=${encodeURIComponent(cursor)}`;
  const readFeedPage = (cursor: string): Effect.Effect<BanneretFeedEntryPageRead> =>
    readPage<BanneretFeedEntryPage>(`/relay/v1/feed${pageQuery(cursor)}`, reshapeFeedPage);
  const readGraveyardPage = (cursor: string): Effect.Effect<BanneretGraveyardPageRead> =>
    readPage<BanneretGraveyardPage>(
      `/relay/v1/graveyard${pageQuery(cursor)}`,
      reshapeGraveyardPage,
    );

  const readTask = (taskId: string): Effect.Effect<BanneretTaskRead> =>
    readPage(`/relay/v1/tasks/${encodeURIComponent(taskId)}`, reshapeTask, true);

  /** One snapshot reader per joined key: reads on a wake (hint, event, capabilities) or a poll. */
  const watchSnapshot = Effect.fn("BanneretRelayFeed.watchSnapshot")(function* (
    key: string,
    wake: Queue.Queue<void>,
  ) {
    const reader = makeSnapshotReader((target, request) => enrolment.signedGet(target, request));
    snapshotReader = reader;
    for (;;) {
      yield* refreshSnapshot(key, reader);
      yield* Queue.take(wake).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(options.snapshotPollMs),
          orElse: () => Effect.void,
        }),
      );
    }
  });

  /** A new `snapshotEtag` in a heartbeat answer: reread the head unless it is already current. */
  const noticeHint = Effect.gen(function* () {
    const hint = unquoteEtag(yield* enrolment.snapshotEtag);
    if (hint === undefined || hint === lastHint) return;
    lastHint = hint;
    if (hint !== snapshotReader?.currentEtag()) wakeSnapshot();
  });

  /** A heartbeat's `capabilitiesVersion` that is not the one read: reread capabilities, once at a time. */
  let sectionsReader: Fiber.Fiber<void> | undefined;
  const noticeCapabilities = Effect.gen(function* () {
    const version = yield* enrolment.capabilitiesVersion;
    const key = joined?.key;
    if (key === undefined || version === undefined || sectionsReader !== undefined) return;
    if (`"${version}"` === sectionsVersion) return;
    sectionsReader = yield* Effect.forkIn(
      refreshSections(key).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            sectionsReader = undefined;
          }),
        ),
      ),
      layerScope,
    );
  });

  /** Keeps the stream open for one joined key until the key changes (this fiber is interrupted). */
  const follow = Effect.fn("BanneretRelayFeed.follow")(function* (key: string) {
    let delay = 0;
    let connections = 0;
    for (;;) {
      const outcome = yield* connectOnce(
        key,
        Effect.gen(function* () {
          yield* syncAgents;
          yield* syncChat(key);
          connections += 1;
          delay = 0;
          yield* setLive(key, true);
          // Without a resume id the relay cannot replay what a reconnect missed.
          if (connections > 1) yield* bump;
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
  const adoptLock = yield* Semaphore.make(1);
  let follower: Fiber.Fiber<never, never> | undefined;
  let snapshotFiber: Fiber.Fiber<never, never> | undefined;
  const adopt = (next: Joined | null) =>
    adoptLock.withPermits(1)(
      Effect.gen(function* () {
        if (next?.key === joined?.key) return;
        if (follower !== undefined) yield* Fiber.interrupt(follower);
        if (snapshotFiber !== undefined) yield* Fiber.interrupt(snapshotFiber);
        if (sectionsReader !== undefined) yield* Fiber.interrupt(sectionsReader);
        follower = undefined;
        snapshotFiber = undefined;
        snapshotWake = undefined;
        snapshotReader = undefined;
        boardFlags = null;
        snapshotOffered = false;
        board = null;
        boardSignature = "";
        mapFlags = null;
        mapRead = null;
        mapSignature = "";
        feedFlags = null;
        feedRead = null;
        feedSignature = "";
        graveyardRead = null;
        graveyardSignature = "";
        teamFlags = null;
        teamRead = null;
        teamSignature = "";
        lastHint = undefined;
        yield* enrolment.setBoardTasks([]);
        chatSeq = 0;
        chatFlags = [];
        joined = next;
        lastEventId = undefined;
        live = false;
        since = null;
        sections = [];
        sectionsKnown = false;
        dashboardSettings = {};
        sectionsVersion = undefined;
        mcpTools = [];
        needsCount = null;
        today = null;
        needsFirst = null;
        problem = null;
        labels = new Map();
        labelsReadAt = Number.NEGATIVE_INFINITY;
        if (next !== null) {
          if (next.label !== undefined) labels.set(environmentId, next.label);
          yield* refreshSections(next.key);
          yield* syncAgents;
          follower = yield* Effect.forkIn(follow(next.key) as Effect.Effect<never>, layerScope);
          const wake = yield* Queue.sliding<void>(1);
          snapshotWake = wake;
          snapshotFiber = yield* Effect.forkIn(
            watchSnapshot(next.key, wake) as Effect.Effect<never>,
            layerScope,
          );
        }
        yield* publishSnapshot;
      }),
    );

  yield* adopt(joinedOf(yield* enrolment.status));

  // One supervisor: follows the enrolment, so the stream runs only while configured.
  yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        const changed = yield* enrolment.nextChange;
        yield* adopt(joinedOf(yield* enrolment.status));
        yield* noticeHint;
        yield* noticeCapabilities;
        yield* changed;
      }),
    ),
    layerScope,
  );

  const events = Stream.callback<BanneretFeedState>(
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

  if (agents)
    yield* Effect.forkIn(
      Effect.forever(Effect.sleep("10 seconds").pipe(Effect.andThen(syncAgents))),
      layerScope,
    );
  if (handoffs)
    yield* Effect.forkIn(
      Effect.forever(
        Effect.sleep("5 seconds").pipe(
          Effect.andThen(
            Effect.suspend(() =>
              joined && chatFlags.includes("handoffs")
                ? handoffs.reconcile(enrolment, readTask)
                : Effect.void,
            ),
          ),
        ),
      ),
      layerScope,
    );
  const service: RelayFeedInstance = {
    chat: (action) =>
      joined && sections.includes(action.kind === "roles" ? "roles" : "chat")
        ? action.kind === "offerHandoff" ||
          action.kind === "acceptHandoff" ||
          action.kind === "advanceHandoff" ||
          action.kind === "withdrawHandoff"
          ? handoffs && chatFlags.includes("handoffs")
            ? handoffs.act(enrolment, readTask, action)
            : Effect.succeed(chatUnavailable)
          : action.kind === "threadChat"
            ? agents && chatFlags.includes("agents")
              ? agents.settings(enrolment, action)
              : Effect.succeed(chatUnavailable)
            : action.kind === "selfCheck"
              ? agents && chatFlags.includes("reviews")
                ? agents.selfCheck(enrolment, action)
                : Effect.succeed(chatUnavailable)
              : action.kind === "postReview"
                ? chatFlags.includes("promote")
                  ? postReview(enrolment, github?.pullRequests, action.id)
                  : Effect.succeed(chatUnavailable)
                : action.kind === "promote"
                  ? chatFlags.includes("promote")
                    ? promote(enrolment, github, action)
                    : Effect.succeed(chatUnavailable)
                  : action.kind === "search" && !chatFlags.includes("search")
                    ? Effect.succeed(chatUnavailable)
                    : channelAction(enrolment.signedChat, action)
        : Effect.succeed(chatUnavailable),
    today: readToday,
    needs: readNeeds,
    agents: (cursor) =>
      !teamFlags
        ? Effect.succeed(null)
        : Effect.map(
            readPage("/relay/v1/team/agents" + pageQuery(cursor), (body) =>
              Option.getOrUndefined(decodeOfficeAgentPage(body)),
            ),
            (r) => r.value,
          ),
    room: Effect.fn("BanneretRelayFeed.room")(function* (board: string | null, cursor?: string) {
      const key = board === null ? "team.hallway" : "team.room." + board;
      if (!joined || !teamFlags || !snapshotReader?.roomRefs()[key]) return null;
      const decode = (body: unknown) => Option.getOrUndefined(decodeOfficeRoomPage(body));
      if (cursor === undefined)
        return yield* snapshotReader.roomFile(key).pipe(
          Effect.map((body) => decode(body) ?? null),
          Effect.orElseSucceed(() => null),
        );
      const path = board === null ? "hallway" : "rooms/" + encodeURIComponent(board);
      return (yield* readPage("/relay/v1/team/" + path + "/sessions" + pageQuery(cursor), decode))
        .value;
    }),
    feedPage: readFeedPage,
    graveyardPage: readGraveyardPage,
    task: readTask,
    events,
    mcpTools: Effect.sync(() => (sectionsKnown ? mcpTools : null)),
  };
  return service;
});

const make = Effect.fn("BanneretRelayFeed.make")(function* (
  overrides: Partial<RelayFeedOptions> = {},
  agents?: Effect.Success<typeof makeDeliveries>,
  github?: SourceControlDriverInstance,
  handoffs?: Effect.Success<typeof makeHandoffs>,
) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const enrolment = yield* BanneretEnrolment;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const layerScope = yield* Effect.scope;
  // One feed per relay instance of the enrolment, added when the enrolment adds the relay.
  const feeds = new Map<string, RelayFeedInstance>();
  const addLock = yield* Semaphore.make(1);

  const feedFor = (relayOrigin: string) =>
    addLock.withPermits(1)(
      Effect.gen(function* () {
        const relay = yield* enrolment.relay(relayOrigin);
        if (relay === undefined) return undefined;
        const existing = feeds.get(relay.origin);
        if (existing !== undefined) return existing;
        const added = yield* makeRelayFeed(
          relay,
          environmentId,
          options,
          layerScope,
          agents,
          github,
          handoffs,
        );
        feeds.set(relay.origin, added);
        return added;
      }),
    );

  // Feeds for the relays found at start-up, so their streams open without waiting for a client.
  const addAll = Effect.gen(function* () {
    for (const view of yield* enrolment.list) yield* feedFor(view.relayOrigin);
  });
  yield* addAll;
  yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        const changed = yield* enrolment.nextChange;
        yield* addAll;
        yield* changed;
      }),
    ),
    layerScope,
  );

  const notJoined = <A>(relayOrigin: string, run: (feed: RelayFeedInstance) => Effect.Effect<A>) =>
    Effect.flatMap(feedFor(relayOrigin), (feed): Effect.Effect<A | typeof NOT_JOINED> =>
      feed === undefined ? Effect.succeed(NOT_JOINED) : run(feed),
    );

  /** A relay not joined yet answers as not joined, then follows its feed once it is added. */
  const waitForFeed = Effect.fn("BanneretRelayFeed.waitForFeed")(function* (relayOrigin: string) {
    for (;;) {
      const changed = yield* enrolment.nextChange;
      const feed = yield* feedFor(relayOrigin);
      if (feed !== undefined) return feed;
      yield* changed;
    }
  });

  const service: FeedService = {
    room: (origin, board, cursor) =>
      Effect.flatMap(feedFor(origin), (feed) =>
        feed ? feed.room(board, cursor) : Effect.succeed(null),
      ),
    agents: (origin, cursor) =>
      Effect.flatMap(feedFor(origin), (feed) =>
        feed ? feed.agents(cursor) : Effect.succeed(null),
      ),
    chat: (origin, action) =>
      Effect.flatMap(feedFor(origin), (feed) =>
        feed ? feed.chat(action) : Effect.succeed(chatUnavailable),
      ),
    today: (relayOrigin, since) => notJoined(relayOrigin, (feed) => feed.today(since)),
    needs: (relayOrigin, cursor) => notJoined(relayOrigin, (feed) => feed.needs(cursor)),
    feedPage: (relayOrigin, cursor) => notJoined(relayOrigin, (feed) => feed.feedPage(cursor)),
    graveyardPage: (relayOrigin, cursor) =>
      notJoined(relayOrigin, (feed) => feed.graveyardPage(cursor)),
    task: (relayOrigin, taskId) => notJoined(relayOrigin, (feed) => feed.task(taskId)),
    mcpTools: (relayOrigin) =>
      Effect.flatMap(feedFor(relayOrigin), (feed) =>
        feed === undefined ? Effect.succeed(null) : feed.mcpTools,
      ),
    events: (relayOrigin) =>
      Stream.unwrap(
        Effect.map(feedFor(relayOrigin), (feed) =>
          feed !== undefined
            ? feed.events
            : Stream.concat(
                Stream.make(NOT_JOINED_SNAPSHOT),
                Stream.unwrap(Effect.map(waitForFeed(relayOrigin), (added) => added.events)),
              ),
        ),
      ),
  };
  return service;
});

export const layerWith = (options: Partial<RelayFeedOptions>) =>
  Layer.effect(BanneretRelayFeed, make(options));

export const layer = Layer.effect(
  BanneretRelayFeed,
  Effect.gen(function* () {
    const agents = yield* makeDeliveries;
    const drivers = yield* SourceControlDrivers;
    return yield* make(
      {},
      agents,
      drivers.find((d) => d.driver.kind === "github")?.instance,
      yield* makeHandoffs,
    );
  }),
);

/** Handlers for the feed RPCs, spread into the WebSocket handler group. */
export const rpcHandlers = {
  [BANNERET_RELAY_FEED_WS_METHODS.roles]: (input: {
    relayOrigin: string;
    action: Extract<ChannelAction, { kind: "roles" }>["action"];
  }) =>
    Effect.flatMap(BanneretRelayFeed, (feed) =>
      feed.chat(input.relayOrigin, { kind: "roles", action: input.action }),
    ),
  [BANNERET_RELAY_FEED_WS_METHODS.chat]: (input: { relayOrigin: string; action: ChannelAction }) =>
    Effect.flatMap(BanneretRelayFeed, (feed) => feed.chat(input.relayOrigin, input.action)),
  [BANNERET_RELAY_FEED_WS_METHODS.today]: (input: {
    readonly relayOrigin: string;
    readonly since?: string | undefined;
  }) => Effect.flatMap(BanneretRelayFeed, (feed) => feed.today(input.relayOrigin, input.since)),
  [BANNERET_RELAY_FEED_WS_METHODS.needs]: (input: {
    readonly relayOrigin: string;
    readonly cursor?: string | undefined;
  }) => Effect.flatMap(BanneretRelayFeed, (feed) => feed.needs(input.relayOrigin, input.cursor)),
  [BANNERET_RELAY_FEED_WS_METHODS.feed]: (input: { readonly relayOrigin: string }) =>
    Stream.unwrap(Effect.map(BanneretRelayFeed, (feed) => feed.events(input.relayOrigin))),
  [BANNERET_RELAY_FEED_WS_METHODS.room]: (input: {
    relayOrigin: string;
    board: string | null;
    cursor?: string | undefined;
  }) =>
    Effect.flatMap(BanneretRelayFeed, (feed) =>
      feed.room(input.relayOrigin, input.board, input.cursor),
    ),
  [BANNERET_RELAY_FEED_WS_METHODS.agents]: (input: { relayOrigin: string; cursor: string }) =>
    Effect.flatMap(BanneretRelayFeed, (feed) => feed.agents(input.relayOrigin, input.cursor)),
  [BANNERET_RELAY_FEED_WS_METHODS.feedPage]: (input: {
    readonly relayOrigin: string;
    readonly cursor: string;
  }) => Effect.flatMap(BanneretRelayFeed, (feed) => feed.feedPage(input.relayOrigin, input.cursor)),
  [BANNERET_RELAY_FEED_WS_METHODS.graveyardPage]: (input: {
    readonly relayOrigin: string;
    readonly cursor: string;
  }) =>
    Effect.flatMap(BanneretRelayFeed, (feed) =>
      feed.graveyardPage(input.relayOrigin, input.cursor),
    ),
  [BANNERET_RELAY_FEED_WS_METHODS.task]: (input: {
    readonly relayOrigin: string;
    readonly taskId: string;
  }) => Effect.flatMap(BanneretRelayFeed, (feed) => feed.task(input.relayOrigin, input.taskId)),
};
