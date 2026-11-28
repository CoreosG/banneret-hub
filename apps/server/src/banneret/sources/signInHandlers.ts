// Banneret Hub: what Settings and a thread show about this machine's sign-ins to company sources, and
// the person's actions on them. No token is ever sent back.
import {
  type SignInAction,
  type SourceSignIn,
  TaskLeaseError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { pluginsForThread } from "../plugins/session.ts";
import { readForMemory } from "../Workspaces.ts";
import { mayCarrySignIn } from "./addresses.ts";
import { finishSignIn, saveSourceToken, signOut, startSignIn, waitingSignIn } from "./oauth.ts";
import { sourcesFor, type ThreadSource } from "./ThreadSources.ts";
import { readCredential, signInChanges, signInState } from "./tokens.ts";

const isTaskError = Schema.is(TaskLeaseError);
const failure = (error: unknown) =>
  isTaskError(error)
    ? error
    : new TaskLeaseError({ reason: "failed", detail: "Could not access your company sign-ins." });

const joinedRelays = Effect.map(readForMemory, (workspaces) =>
  workspaces.flatMap((workspace) =>
    workspace.kind === "enterprise" && !workspace.deleted && workspace.relay
      ? [workspace.relay]
      : [],
  ),
);

const row = Effect.fn("BanneretSignIn.row")(function* (source: ThreadSource, company: string) {
  const { relayOrigin, company: published } = source;
  const { id, title, url, auth, help } = published;
  const now = yield* Clock.currentTimeMillis;
  const state =
    auth === "none"
      ? ("network" as const)
      : !mayCarrySignIn(url, relayOrigin, url)
        ? ("refused" as const)
        : signInState(yield* readCredential(relayOrigin, id), published, now);
  const authorizationUrl = auth === "oauth" ? waitingSignIn(relayOrigin, id, now) : undefined;
  return {
    relayOrigin,
    company,
    sourceId: id,
    title,
    address: URL.parse(url)?.host ?? url,
    auth,
    state,
    ...(help ? { help } : {}),
    ...(authorizationUrl ? { authorizationUrl } : {}),
  } satisfies SourceSignIn;
});

/** The sources of one thread, or of every company this machine's workspaces joined. */
export const signInRows = Effect.fn("BanneretSignIn.rows")(function* (
  threadId: ThreadId | undefined,
) {
  const relays = yield* joinedRelays;
  let sources: ReadonlyArray<ThreadSource>;
  if (threadId) {
    const records = yield* (yield* ThreadManagementService).getThreadRecords(threadId, []);
    const plugins = yield* pluginsForThread(
      records.thread,
      yield* (yield* ServerEnvironment).getEnvironmentId,
    );
    sources = plugins.flatMap((plugin) => (plugin.company ? [plugin] : []));
  } else {
    const origins = [...new Set(relays.map((relay) => relay.origin))];
    sources = (yield* Effect.forEach(origins, sourcesFor)).flat();
  }
  return yield* Effect.forEach(sources, (source) =>
    row(
      source,
      relays.find((relay) => relay.origin === source.relayOrigin)?.displayName ?? "Your company",
    ),
  );
});

const act = Effect.fn("BanneretSignIn.act")(function* (action: SignInAction) {
  switch (action.kind) {
    case "start":
      yield* startSignIn(action.relayOrigin, action.sourceId);
      return;
    case "finish":
      yield* finishSignIn(Redacted.value(action.callbackUrl));
      return;
    case "token":
      yield* saveSourceToken(
        action.relayOrigin,
        action.sourceId,
        Redacted.value(action.token).trim(),
      );
      return;
    case "sign_out":
      yield* signOut(action.relayOrigin, action.sourceId);
      return;
  }
});

export const signInHandlers = {
  "plugins.signIns": ({ threadId }: { threadId?: ThreadId | undefined }) =>
    signInChanges.pipe(
      Stream.mapEffect(() => signInRows(threadId)),
      Stream.mapError(failure),
    ),
  // The sign-in page and any outcome show up in the stream above.
  "plugins.signIn": ({ action }: { action: SignInAction }) =>
    act(action).pipe(Effect.mapError(failure)),
};
