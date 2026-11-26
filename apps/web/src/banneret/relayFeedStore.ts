// Banneret Hub: this client's copy of Today and Needs you for each environment. The server makes
// every relay call; the client reads `banneretRelay.today` / `banneretRelay.needs` and follows the
// `banneretRelay.feed` stream, refetching when it says something changed. A failed read keeps the
// last good copy, so the screens show old data with its age rather than nothing.
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  BANNERET_RELAY_FEED_WS_METHODS,
  type BanneretFeedBoardRead,
  type BanneretFeedState,
  type BanneretFeedNeedsItem,
  type BanneretFeedNeedsRead,
  type BanneretFeedToday,
  type BanneretFeedTodayRead,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const todayCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:today",
  tag: BANNERET_RELAY_FEED_WS_METHODS.today,
});
const needsCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:needs",
  tag: BANNERET_RELAY_FEED_WS_METHODS.needs,
});
const feedAtom = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:banneret-relay:feed",
  tag: BANNERET_RELAY_FEED_WS_METHODS.feed,
});

async function settled<T>(run: Promise<AtomCommandResult<T, unknown>>): Promise<T | null> {
  try {
    const result = await run;
    return result._tag === "Success" ? result.value : null;
  } catch {
    return null;
  }
}

/** Every call the feed makes; tests replace these. */
export const feedRpc = {
  today: (environmentId: EnvironmentId, visit: boolean): Promise<BanneretFeedTodayRead | null> =>
    settled(
      runAtomCommand(appAtomRegistry, todayCommand, {
        environmentId,
        input: visit ? { visit: true } : {},
      }),
    ),
  needs: (environmentId: EnvironmentId, cursor?: string): Promise<BanneretFeedNeedsRead | null> =>
    settled(
      runAtomCommand(appAtomRegistry, needsCommand, {
        environmentId,
        input: cursor === undefined ? {} : { cursor },
      }),
    ),
  /** Calls `listener` with each feed state; returns the unsubscribe. */
  subscribe: (environmentId: EnvironmentId, listener: (event: BanneretFeedState) => void) =>
    appAtomRegistry.subscribe(
      feedAtom({ environmentId, input: {} }),
      (result) => {
        if (AsyncResult.isSuccess(result)) listener(result.value);
      },
      { immediate: true },
    ),
};

export interface FeedProblem {
  readonly message: string;
  readonly since: string;
}

export interface EnvironmentFeed {
  readonly joined: boolean;
  readonly live: boolean;
  readonly liveSince: string | null;
  /** False until the relay's capabilities have been read; sections then show until they are. */
  readonly sectionsKnown: boolean;
  readonly sections: ReadonlyArray<string>;
  /** From the last `needs.changed`; null until one arrives. */
  readonly needsCount: number | null;
  readonly today: BanneretFeedToday | null;
  readonly todayFetchedAt: string | null;
  readonly todayProblem: FeedProblem | null;
  readonly needs: ReadonlyArray<BanneretFeedNeedsItem> | null;
  readonly needsNextCursor: string | null;
  readonly needsFetchedAt: string | null;
  readonly needsProblem: FeedProblem | null;
  /** The board from the relay's snapshot; null when the relay offers none or it is not read yet. */
  readonly board: BanneretFeedBoardRead | null;
  /** A read that failed without any answer from this environment. */
  readonly unreachable: boolean;
}

const EMPTY_FEED: EnvironmentFeed = {
  joined: false,
  live: false,
  liveSince: null,
  sectionsKnown: false,
  sections: [],
  needsCount: null,
  today: null,
  todayFetchedAt: null,
  todayProblem: null,
  needs: null,
  needsNextCursor: null,
  needsFetchedAt: null,
  needsProblem: null,
  board: null,
  unreachable: false,
};

interface FeedState {
  readonly feeds: Readonly<Record<EnvironmentId, EnvironmentFeed>>;
}

export const useRelayFeedStore = create<FeedState>(() => ({ feeds: {} }));

const update = (environmentId: EnvironmentId, patch: Partial<EnvironmentFeed>) =>
  useRelayFeedStore.setState((state) => ({
    feeds: {
      ...state.feeds,
      [environmentId]: { ...(state.feeds[environmentId] ?? EMPTY_FEED), ...patch },
    },
  }));

export function useEnvironmentFeed(environmentId: EnvironmentId | null): EnvironmentFeed {
  return useRelayFeedStore((state) =>
    environmentId === null ? EMPTY_FEED : (state.feeds[environmentId] ?? EMPTY_FEED),
  );
}

/** Reads Today. `visit` only when the person opens Today; refetches never send it. */
export async function refreshToday(environmentId: EnvironmentId, visit = false) {
  const read = await feedRpc.today(environmentId, visit);
  if (read === null) {
    update(environmentId, { unreachable: true });
    return;
  }
  update(environmentId, {
    joined: read.joined,
    unreachable: false,
    todayProblem: read.problem ?? null,
    ...(read.value === null ? {} : { today: read.value, todayFetchedAt: read.fetchedAt }),
  });
}

/** Reads the first page of Needs you, replacing any pages loaded before. */
async function refreshNeeds(environmentId: EnvironmentId) {
  const read = await feedRpc.needs(environmentId);
  if (read === null) {
    update(environmentId, { unreachable: true });
    return;
  }
  update(environmentId, {
    joined: read.joined,
    unreachable: false,
    needsProblem: read.problem ?? null,
    ...(read.value === null
      ? {}
      : {
          needs: read.value.items,
          needsNextCursor: read.value.nextCursor,
          needsFetchedAt: read.fetchedAt,
        }),
  });
}

export async function loadMoreNeeds(environmentId: EnvironmentId) {
  const current = useRelayFeedStore.getState().feeds[environmentId];
  const cursor = current?.needsNextCursor ?? null;
  if (cursor === null) return;
  const read = await feedRpc.needs(environmentId, cursor);
  if (read === null || read.value === null) {
    update(
      environmentId,
      read === null ? { unreachable: true } : { needsProblem: read.problem ?? null },
    );
    return;
  }
  const latest = useRelayFeedStore.getState().feeds[environmentId];
  // A refetch meanwhile started the list again; this page belongs to the old one.
  if (latest?.needsNextCursor !== cursor) return;
  update(environmentId, {
    needs: [...(latest.needs ?? []), ...read.value.items],
    needsNextCursor: read.value.nextCursor,
  });
}

// The revision each watched environment's copies were read at.
const seenRevisions = new Map<EnvironmentId, number>();

function applyState(environmentId: EnvironmentId, state: BanneretFeedState) {
  const before = useRelayFeedStore.getState().feeds[environmentId];
  update(environmentId, {
    joined: state.joined,
    live: state.live,
    liveSince: state.since,
    sectionsKnown: state.sectionsKnown,
    sections: state.sections,
    needsCount: state.needsCount,
    board: state.board,
  });
  const seen = seenRevisions.get(environmentId);
  seenRevisions.set(environmentId, state.revision);
  // Joining (or a new company), or a change since the copies were read: read them again.
  const joinedNow = state.joined && before?.joined !== true;
  if (joinedNow || (seen !== undefined && seen !== state.revision)) {
    void refreshToday(environmentId);
    void refreshNeeds(environmentId);
  }
}

const watchers = new Map<EnvironmentId, { count: number; stop: () => void }>();

/**
 * Follows one environment's feed while anything shows it. The first watcher subscribes and reads
 * Today and Needs you; the last one to leave unsubscribes.
 */
export function watchFeed(environmentId: EnvironmentId): () => void {
  const existing = watchers.get(environmentId);
  if (existing !== undefined) {
    existing.count += 1;
  } else {
    const stop = feedRpc.subscribe(environmentId, (state) => applyState(environmentId, state));
    watchers.set(environmentId, { count: 1, stop });
    void refreshToday(environmentId);
    void refreshNeeds(environmentId);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = watchers.get(environmentId);
    if (entry === undefined) return;
    entry.count -= 1;
    if (entry.count === 0) {
      watchers.delete(environmentId);
      seenRevisions.delete(environmentId);
      entry.stop();
    }
  };
}
