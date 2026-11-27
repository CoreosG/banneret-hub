// @effect-diagnostics nodeBuiltinImport:off - node:crypto digest is synchronous.
// Banneret Hub: the relay's snapshot (relay-v1 "Snapshot"): a head naming content-addressed files.
// The head is read with If-None-Match; a file is fetched only when its hash is new, checked against
// that hash, and kept in memory while the current head names it. A file that answers 404 has aged
// out, so the head is read again once. Files are reshaped field by field: relay strings stay data.
import * as NodeCrypto from "node:crypto";

import type {
  BanneretBoard,
  BanneretBoardCard,
  BanneretBoardEntry,
  BanneretBoards,
  BanneretBoardLease,
  BanneretBoardPr,
  BanneretBoardTask,
  BanneretFeedEntry,
  BanneretFeedEntryPage,
  BanneretFeedNotMeasured,
  BanneretGraveyardEntry,
  BanneretGraveyardPage,
  BanneretLastRelease,
  BanneretMap,
  BanneretMapItem,
  BanneretTask,
  BanneretTeam,
  BanneretTeamMachine,
  BanneretTeamSession,
} from "@t3tools/contracts";
import {
  BanneretPrRules,
  allBoardCards,
  capCodePoints,
  capUtf8,
  LEASE_NOTE_MAX_BYTES,
  LEASE_REASON_TEXT_MAX,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";

import { RelayCallError, type RelayReply } from "./RelayClient.ts";

const SNAPSHOT_HEAD = "/relay/v1/snapshot/head";
/** A full 1000-card board can pass the 1 MiB cap other answers keep. */
const SNAPSHOT_FILE_MAX_BYTES = 8 * 1024 * 1024;

const FILE_REF = /^sha256:([0-9a-f]{64})$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type SnapshotGet = (
  target: string,
  options: { readonly ifNoneMatch?: string; readonly maxResponseBytes?: number },
) => Effect.Effect<RelayReply, RelayCallError>;

type Fields = Readonly<Record<string, unknown>>;
const fields = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;
const list = (value: unknown, max: number): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value.slice(0, max) : [];
const defined = <T>(items: ReadonlyArray<T | undefined>): Array<T> =>
  items.filter((item): item is T => item !== undefined);

/** `"sha256:<hex>"` or `sha256:<hex>` → `sha256:<hex>`, so a header ETag compares with a facts hint. */
export const unquoteEtag = (etag: string | undefined): string | undefined =>
  etag?.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

const badFile = (message: string) =>
  new RelayCallError({ status: 200, code: "bad_response", message, retryable: true });

/** The head keys to read: a fixed list, or one chosen from the keys the current head names. */
export type SnapshotWanted =
  | ReadonlyArray<string>
  | ((keys: ReadonlyArray<string>) => ReadonlyArray<string>);

export interface SnapshotRead {
  /** The head's ETag, unquoted. */
  readonly etag: string | undefined;
  /** Hash of each wanted file the head names. */
  readonly refs: Readonly<Record<string, string>>;
  /** Parsed body of each wanted file the head names. */
  readonly files: Readonly<Record<string, unknown>>;
}

/** One reader per joined relay key; a new key starts with an empty cache. */
export function makeSnapshotReader(get: SnapshotGet) {
  let etag: string | undefined;
  let refs: Record<string, string> = {};
  let cache = new Map<string, unknown>();

  const readHead = Effect.fn("BanneretSnapshot.head")(function* (conditional: boolean) {
    const reply = yield* get(
      SNAPSHOT_HEAD,
      conditional && etag !== undefined ? { ifNoneMatch: `"${etag}"` } : {},
    );
    if (reply.status === 304) return;
    const files = fields(fields(reply.body)?.files);
    if (files === undefined) return yield* badFile("The relay's snapshot head had no files.");
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(files)) {
      const hex = typeof value === "string" ? FILE_REF.exec(value)?.[1] : undefined;
      if (hex !== undefined) next[key] = hex;
    }
    refs = next;
    etag = unquoteEtag(reply.etag);
  });

  const readFile = Effect.fn("BanneretSnapshot.file")(function* (hex: string) {
    const cached = cache.get(hex);
    if (cached !== undefined) return cached;
    const reply = yield* get(`/relay/v1/snapshot/files/${hex}`, {
      maxResponseBytes: SNAPSHOT_FILE_MAX_BYTES,
    });
    const digest = NodeCrypto.createHash("sha256").update(reply.bytes).digest("hex");
    if (digest !== hex) return yield* badFile("A snapshot file did not match its hash.");
    cache.set(hex, reply.body);
    return reply.body;
  });

  const keysOf = (wanted: SnapshotWanted) =>
    typeof wanted === "function" ? wanted(Object.keys(refs)) : wanted;

  const readWanted = Effect.fn("BanneretSnapshot.files")(function* (wanted: SnapshotWanted) {
    const files: Record<string, unknown> = {};
    // Chosen from the head just read, so a retry after a newer head picks up its keys.
    for (const key of keysOf(wanted)) {
      const hex = refs[key];
      if (hex !== undefined) files[key] = yield* readFile(hex);
    }
    return files;
  });

  /** Reads the head and the wanted files it names; fails with the relay's error. */
  const read = Effect.fn("BanneretSnapshot.read")(function* (wanted: SnapshotWanted) {
    yield* readHead(true);
    const files = yield* readWanted(wanted).pipe(
      // A 404 file has aged out of retention: the head moved on. Read it again, once.
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.andThen(readHead(false), readWanted(wanted)),
      ),
    );
    const named = new Set(Object.values(refs));
    cache = new Map([...cache].filter(([hex]) => named.has(hex)));
    const wantedRefs: Record<string, string> = {};
    for (const key of keysOf(wanted)) {
      const hex = refs[key];
      if (hex !== undefined) wantedRefs[key] = hex;
    }
    return { etag, refs: wantedRefs, files } satisfies SnapshotRead;
  });

  return {
    read,
    /** The current head's ETag, unquoted; undefined before the first head. */
    currentEtag: () => etag,
  };
}

const notMeasured = (value: unknown): BanneretFeedNotMeasured | undefined => {
  const source = fields(value);
  const sourceName = text(source?.source, 64);
  const reason = text(source?.reason, 64);
  const since = text(source?.since, 64);
  const detail = text(source?.detail, 240);
  return sourceName === undefined || reason === undefined || since === undefined
    ? undefined
    : { source: sourceName, reason, since, ...(detail === undefined ? {} : { detail }) };
};

const lease = (value: unknown): BanneretBoardLease | undefined => {
  const source = fields(value);
  const login = text(fields(source?.holder)?.login, 64);
  const state = text(source?.state, 32);
  const since = text(source?.since, 64);
  const lastSignalAt = text(source?.lastSignalAt, 64);
  const staleAt = text(source?.staleAt, 64);
  const expiresAt = text(source?.expiresAt, 64);
  if (
    login === undefined ||
    state === undefined ||
    since === undefined ||
    lastSignalAt === undefined ||
    staleAt === undefined ||
    expiresAt === undefined
  ) {
    return undefined;
  }
  return { holder: { login }, state, since, lastSignalAt, staleAt, expiresAt };
};

/** The card's last release; undefined when a required field is missing. Text keeps the protocol's caps. */
const lastRelease = (value: unknown): BanneretLastRelease | undefined => {
  const source = fields(value);
  const by = text(fields(source?.by)?.login, 64);
  const at = text(source?.at, 64);
  const reason = text(source?.reason, 64);
  const freeToContinue = source?.freeToContinue;
  if (by === undefined || at === undefined || reason === undefined) return undefined;
  if (typeof freeToContinue !== "boolean") return undefined;
  const reasonText =
    typeof source?.reasonText === "string"
      ? capCodePoints(source.reasonText, LEASE_REASON_TEXT_MAX)
      : undefined;
  const note =
    typeof source?.note === "string" ? capUtf8(source.note, LEASE_NOTE_MAX_BYTES) : undefined;
  return {
    by: { login: by },
    at,
    reason,
    freeToContinue,
    ...(reasonText === undefined || reasonText === "" ? {} : { reasonText }),
    ...(note === undefined || note === "" ? {} : { note }),
  };
};

/** A relay tracker ref `{tracker, host?, scope, key, url}`; undefined when a required field is missing. */
export const boardTaskRef = (value: unknown): BanneretBoardTask["ref"] | undefined => {
  const ref = fields(value);
  const tracker = text(ref?.tracker, 32);
  const scope = text(ref?.scope, 200);
  const key = text(ref?.key, 100);
  const url = text(ref?.url, 2048);
  if (tracker === undefined || scope === undefined || key === undefined || url === undefined) {
    return undefined;
  }
  const host = text(ref?.host, 255);
  return { tracker, scope, key, url, ...(host === undefined ? {} : { host }) };
};

/**
 * A relay task `{id, title, ref, openedAt, closedAt}`; undefined when a required field is missing.
 * `closedAt` is null while the issue is open.
 */
const boardTask = (value: unknown): BanneretBoardTask | undefined => {
  const task = fields(value);
  const id = text(task?.id, 64);
  const title = text(task?.title, 300);
  const ref = boardTaskRef(task?.ref);
  const openedAt = text(task?.openedAt, 64);
  const closedAt = task?.closedAt === null ? null : text(task?.closedAt, 64);
  if (
    id === undefined ||
    title === undefined ||
    ref === undefined ||
    openedAt === undefined ||
    closedAt === undefined
  ) {
    return undefined;
  }
  return { id, title, ref, openedAt, closedAt };
};

/** One linked pull request `{number, url, state, checks?}`; undefined when a required field is missing. */
const decodeRules = Schema.decodeUnknownOption(BanneretPrRules);
const linkedPr = (value: unknown): BanneretBoardPr | undefined => {
  const pr = fields(value);
  const number = pr?.number;
  const url = text(pr?.url, 2048);
  const state = text(pr?.state, 32);
  if (typeof number !== "number" || !Number.isInteger(number) || url === undefined)
    return undefined;
  if (state === undefined) return undefined;
  const checks = text(fields(pr?.checks)?.state, 32);
  return {
    number,
    url,
    state,
    ...optional("rules", Option.getOrUndefined(decodeRules(pr))),
    ...(checks === undefined ? {} : { checks: { state: checks } }),
  };
};

const card = (value: unknown): BanneretBoardCard | undefined => {
  const source = fields(value);
  const task = boardTask(source?.task);
  const kind = text(source?.kind, 32);
  const column = text(source?.column, 32);
  const status = text(source?.status, 32);
  const statusWhy = text(source?.statusWhy, 240);
  if (
    task === undefined ||
    kind === undefined ||
    column === undefined ||
    status === undefined ||
    statusWhy === undefined
  ) {
    return undefined;
  }
  const held = lease(source?.lease);
  const released = lastRelease(source?.lastRelease);
  return {
    task,
    kind,
    column,
    status,
    statusWhy,
    ...(held === undefined ? {} : { lease: held }),
    ...(released === undefined ? {} : { lastRelease: released }),
    assignees: defined(list(source?.assignees, 10).map(person)),
    prs: defined(list(source?.prs, 20).map(linkedPr)),
    restsOn: defined(list(source?.restsOn, 100).map((entry) => text(entry, 64))),
  };
};

/** A `board.<id>` file (SnapshotBoard); undefined when it is not one. */
export function reshapeBoard(body: unknown): BanneretBoard | undefined {
  const source = fields(body);
  if (source === undefined || !Array.isArray(source.cards) || !Array.isArray(source.columns)) {
    return undefined;
  }
  return {
    state: text(source.state, 32) ?? "not_measured",
    notMeasured: defined(list(source.notMeasured, 32).map(notMeasured)),
    columns: defined(
      list(source.columns, 51).map((value) => {
        const column = fields(value);
        const id = text(column?.id, 32);
        const title = text(column?.title, 40);
        return id === undefined || title === undefined ? undefined : { id, title };
      }),
    ),
    cards: defined(list(source.cards, 1000).map(card)),
  };
}

/** The head key of one board's file. */
const boardFileKey = (id: string) => `board.${id}`;

/** The head keys the boards need: the index and every `board.<id>` the head names. */
export const boardHeadKeys = (keys: ReadonlyArray<string>): ReadonlyArray<string> =>
  keys.filter((key) => key === "boards" || (key.startsWith("board.") && ID.test(key.slice(6))));

/**
 * The `boards` index (SnapshotBoards) with each board's file from `files`; undefined when the index
 * is not one. A board whose file is missing or unreadable keeps its entry with `board` null; a
 * repeated or malformed id is dropped.
 */
export function reshapeBoards(
  index: unknown,
  files: Readonly<Record<string, unknown>>,
): BanneretBoards | undefined {
  const source = fields(index);
  if (source === undefined || !Array.isArray(source.boards)) return undefined;
  const seen = new Set<string>();
  const boards: Array<BanneretBoardEntry> = [];
  for (const value of list(source.boards, 50)) {
    const entry = fields(value);
    const id = text(entry?.id, 64);
    const title = text(entry?.title, 60);
    const mode = text(entry?.mode, 32);
    const sourceKind = text(fields(entry?.source)?.kind, 32);
    if (id === undefined || !ID.test(id) || seen.has(id)) continue;
    if (title === undefined || mode === undefined || sourceKind === undefined) continue;
    seen.add(id);
    const url = text(fields(entry?.source)?.url, 2048);
    const key = boardFileKey(id);
    boards.push({
      id,
      title,
      mode,
      source: { kind: sourceKind, ...(url === undefined ? {} : { url }) },
      counts: statusCounts(entry?.counts, 51),
      board: key in files ? (reshapeBoard(files[key]) ?? null) : null,
    });
  }
  return { boards };
}

const mapItem = (value: unknown): BanneretMapItem | undefined => {
  const source = fields(value);
  const id = text(source?.id, 64);
  const stageId = text(source?.stageId, 64);
  const title = text(source?.title, 300);
  const status = text(source?.status, 32);
  const statusWhy = text(source?.statusWhy, 240);
  if (
    id === undefined ||
    stageId === undefined ||
    title === undefined ||
    status === undefined ||
    statusWhy === undefined
  ) {
    return undefined;
  }
  const task = boardTask(source?.task);
  return {
    id,
    stageId,
    title,
    status,
    statusWhy,
    ...(task === undefined ? {} : { task }),
    restsOn: defined(list(source?.restsOn, 100).map((entry) => text(entry, 64))),
    blockedBy: defined(list(source?.blockedBy, 100).map((entry) => text(entry, 64))),
  };
};

/** `{<status>: n}`: string keys (at most `max`), non-negative whole counts only. */
const statusCounts = (value: unknown, max = 32): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(fields(value) ?? {}).slice(0, max)) {
    if (key.length <= 64 && typeof count === "number" && Number.isInteger(count) && count >= 0) {
      counts[key] = count;
    }
  }
  return counts;
};

/** The `map` file (SnapshotMap); undefined when it is not one. */
export function reshapeMap(body: unknown): BanneretMap | undefined {
  const source = fields(body);
  if (source === undefined || !Array.isArray(source.stages) || !Array.isArray(source.items)) {
    return undefined;
  }
  const counters = fields(source.counters);
  const byStage: Record<string, Record<string, number>> = {};
  for (const [stageId, counts] of Object.entries(fields(counters?.byStage) ?? {}).slice(0, 200)) {
    if (stageId.length <= 64) byStage[stageId] = statusCounts(counts);
  }
  return {
    state: text(source.state, 32) ?? "not_measured",
    notMeasured: defined(list(source.notMeasured, 32).map(notMeasured)),
    stages: defined(
      list(source.stages, 200).map((value) => {
        const stage = fields(value);
        const id = text(stage?.id, 64);
        const title = text(stage?.title, 120);
        const order = stage?.order;
        return id === undefined ||
          title === undefined ||
          typeof order !== "number" ||
          !Number.isFinite(order)
          ? undefined
          : { id, title, order };
      }),
    ),
    items: defined(list(source.items, 2000).map(mapItem)),
    counters: { byStatus: statusCounts(counters?.byStatus), byStage },
  };
}

const person = (value: unknown) => {
  const login = text(fields(value)?.login, 64);
  return login === undefined ? undefined : { login };
};

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const feedEntry = (value: unknown): BanneretFeedEntry | undefined => {
  const source = fields(value);
  const id = text(source?.id, 64);
  const type = text(source?.type, 64);
  const at = text(source?.at, 64);
  const importance = text(source?.importance, 32);
  const summary = text(source?.summary, 240);
  if (
    id === undefined ||
    type === undefined ||
    at === undefined ||
    importance === undefined ||
    summary === undefined
  ) {
    return undefined;
  }
  return {
    id,
    type,
    at,
    importance,
    summary,
    ...optional("author", person(source?.author)),
    ...optional("link", text(source?.link, 2048)),
    ...optional("task", boardTask(source?.task)),
    ...optional("status", text(source?.status, 32)),
  };
};

const graveyardEntry = (value: unknown): BanneretGraveyardEntry | undefined => {
  const source = fields(value);
  const task = boardTask(source?.task);
  const cause = text(source?.cause, 500);
  const ruledAt = text(source?.ruledAt, 64);
  if (task === undefined || cause === undefined || ruledAt === undefined) return undefined;
  return {
    task,
    cause,
    ruledAt,
    ...optional("by", person(source?.by)),
    ...optional("link", text(source?.link, 2048)),
  };
};

const entryPage = <T>(body: unknown, entry: (value: unknown) => T | undefined) => {
  const source = fields(body);
  if (source === undefined || !Array.isArray(source.entries)) return undefined;
  return {
    entries: defined(list(source.entries, 100).map(entry)),
    nextCursor: text(source.nextCursor, 1024) ?? null,
  };
};

/** The `feed` file or a `GET /feed` page (FeedPage); undefined when it is not one. */
export const reshapeFeedPage = (body: unknown): BanneretFeedEntryPage | undefined =>
  entryPage(body, feedEntry);

/** The `graveyard` file or a `GET /graveyard` page (GraveyardPage); undefined when it is not one. */
export const reshapeGraveyardPage = (body: unknown): BanneretGraveyardPage | undefined =>
  entryPage(body, graveyardEntry);

/** `GET /tasks/{taskId}` (TaskRead): a board card plus its preview and sign-off; undefined when not one. */
export function reshapeTask(body: unknown): BanneretTask | undefined {
  const base = card(body);
  if (base === undefined) return undefined;
  const source = fields(body);
  const previewSource = fields(source?.preview);
  const previewState = text(previewSource?.state, 32);
  const checkedSource = fields(source?.checked);
  const checkedBy = person(checkedSource?.by);
  const checkedAt = text(checkedSource?.at, 64);
  const valid = checkedSource?.valid;
  return {
    ...base,
    ...(previewState === undefined
      ? {}
      : {
          preview: {
            state: previewState,
            ...optional("url", text(previewSource?.url, 2048)),
          },
        }),
    ...(checkedBy === undefined || checkedAt === undefined || typeof valid !== "boolean"
      ? {}
      : {
          checked: {
            by: checkedBy,
            at: checkedAt,
            valid,
            ...optional("ignoredReason", text(checkedSource?.ignoredReason, 240)),
          },
        }),
  };
}

const teamSession = (value: unknown): BanneretTeamSession | undefined => {
  const source = fields(value);
  const id = text(source?.id, 64);
  const machineId = text(source?.machineId, 64);
  const provider = text(source?.provider, 32);
  const state = text(source?.state, 32);
  const since = text(source?.since, 64);
  if (
    id === undefined ||
    machineId === undefined ||
    provider === undefined ||
    state === undefined ||
    since === undefined
  ) {
    return undefined;
  }
  return {
    id,
    ...optional("parentId", text(source?.parentId, 64)),
    machineId,
    provider,
    state,
    ...optional("waiting", text(source?.waiting, 32)),
    ...optional("taskId", text(source?.taskId, 64)),
    since,
  };
};

/** Live machines from the `machines` file (SnapshotMachines), by owner id. Revoked ones are left out. */
const machinesByOwner = (
  body: unknown,
): ReadonlyMap<string, ReadonlyArray<BanneretTeamMachine>> => {
  const byOwner = new Map<string, Array<BanneretTeamMachine>>();
  for (const value of list(fields(body)?.items, 500)) {
    const source = fields(value);
    const id = text(source?.id, 64);
    const owner = text(source?.ownerId, 64);
    const label = text(source?.label, 64);
    if (id === undefined || owner === undefined || label === undefined) continue;
    if (source?.revokedAt !== undefined && source.revokedAt !== null) continue;
    const machine = {
      id,
      label,
      ...(typeof source?.poolHostId === "string" ? { poolHostId: source.poolHostId } : {}),
      kind: text(source?.kind, 32) ?? "",
      connected: source?.connected === true,
    };
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), machine]);
  }
  return byOwner;
};

/**
 * The `team` file (SnapshotTeam) joined with the `machines` file: each person with their live machines and
 * sessions. Undefined when the team file is not one; a missing machines file leaves `machines` empty.
 */
export function reshapeTeam(teamBody: unknown, machinesBody: unknown): BanneretTeam | undefined {
  const source = fields(teamBody);
  if (source === undefined || !Array.isArray(source.people)) return undefined;
  const machines = machinesByOwner(machinesBody);
  return {
    people: defined(
      list(source.people, 500).map((value) => {
        const person = fields(value);
        const id = text(person?.id, 64);
        const login = text(person?.login, 64);
        if (id === undefined || login === undefined) return undefined;
        return {
          id,
          login,
          role: text(person?.role, 32) ?? "limited_staff",
          machines: machines.get(id) ?? [],
          sessions: defined(list(person?.sessions, 100).map(teamSession)),
        };
      }),
    ),
  };
}

/** What the Team page shows, as one comparable string: an unchanged read publishes nothing. */
export const teamViewKey = (team: BanneretTeam): string => JSON.stringify(team);

/** Live means an agent session is working or waiting; idle, stopped and unheard ones are not. */
const LIVE_WORK = new Set(["working", "waiting"]);

/** Task ids with a live session in the `work` file (SnapshotWork), for the "agent at work" ring. */
export function liveTaskIds(body: unknown): Array<string> {
  const ids = new Set<string>();
  for (const value of list(fields(fields(body)?.working)?.items, 100)) {
    const item = fields(value);
    const id = text(fields(item?.task)?.id, 64);
    const state = text(item?.state, 32);
    const live =
      state === undefined
        ? typeof item?.sessions === "number" && item.sessions > 0
        : LIVE_WORK.has(state);
    if (id !== undefined && live) ids.add(id);
  }
  return [...ids].toSorted();
}

export interface BoardTaskEntry {
  readonly id: string;
  readonly tracker: string;
  readonly host: string | undefined;
  readonly scope: string;
  readonly key: string;
}

export interface IssueLinkKey {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
}

export const boardTaskIndex = (boards: BanneretBoards): ReadonlyArray<BoardTaskEntry> =>
  allBoardCards(boards).map((entry) => ({
    id: entry.task.id,
    tracker: entry.task.ref.tracker,
    host: entry.task.ref.host,
    scope: entry.task.ref.scope,
    key: entry.task.ref.key,
  }));

const same = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * The board task id of the first linked issue that is on the board, compared as upstream's
 * `threadIssueKeyOf` does. A card without a host matches on tracker, scope and key.
 */
export function taskIdForLinks(
  index: ReadonlyArray<BoardTaskEntry>,
  links: ReadonlyArray<IssueLinkKey>,
): string | undefined {
  for (const link of links) {
    const match = index.find(
      (entry) =>
        entry.tracker === link.tracker &&
        (entry.host === undefined || same(entry.host, link.host)) &&
        same(entry.scope, link.scope) &&
        entry.key.trim() === link.key.trim(),
    );
    if (match !== undefined && ID.test(match.id)) return match.id;
  }
  return undefined;
}
