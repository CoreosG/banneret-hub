// Banneret Hub: Take and Release when a company source owns tasks. The source's claim is the record: the
// Hub calls its `tasks_claim` and `tasks_release` with the person's own sign-in and reads the answer back.
// Nothing here writes to GitHub or sends a write to the relay. The write's states are in
// docs/banneret/agents.md ("Take and Release against a company's tracker").
// @effect-diagnostics nodeBuiltinImport:off - idempotency keys.
import * as NodeCrypto from "node:crypto";

import {
  allBoardCards,
  checkReleaseComment,
  TaskLeaseError,
  type TaskLeaseRef,
  type TaskLeaseReleaseInput,
  type TaskLeaseResult,
  type TaskLeaseStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { BanneretRelayFeed } from "../relay/RelayFeed.ts";
import { companySources, readSavedOwnership, type CompanySource } from "./ownership.ts";
import { findTask, readTask, type ProviderCard } from "./providerTasks.ts";
import { openSource, SourceCallError } from "./sourceClient.ts";

const refused = (detail: string) => new TaskLeaseError({ reason: "refused", detail });
const unavailable = (detail: string) => new TaskLeaseError({ reason: "unavailable", detail });
const failed = (detail: string) => new TaskLeaseError({ reason: "failed", detail });

/**
 * Who answers a lease call for this relay, from the saved owners the server trusts. Null: Banneret does,
 * with its own lease rules. Never decided from anything the client sends.
 */
export const externalTasks = Effect.fn("BanneretProviderLeases.owner")(function* (
  relayOrigin: string,
) {
  const live = yield* (yield* BanneretRelayFeed).elsewhere(relayOrigin);
  const saved = yield* readSavedOwnership(relayOrigin);
  const owner = (live ?? saved?.owners)?.tasks;
  if (!owner) return null;
  if (owner.owner === "off") return { off: "Tasks are turned off at this company." } as const;
  const source = saved
    ? companySources(saved).find((one) => one.id === owner.source && one.owns.includes("tasks"))
    : undefined;
  if (owner.leases === "unsupported")
    return {
      off: `${owner.title} owns tasks, but the relay does not leave claims to it, so take and release are off.`,
    } as const;
  return source
    ? ({ source } as const)
    : ({ off: `The Hub cannot use ${owner.title}, which owns tasks here.` } as const);
});
export type ExternalTasks = NonNullable<Effect.Success<ReturnType<typeof externalTasks>>>;

/** The task on this person's own copy of the board. */
const boardTask = Effect.fn("BanneretProviderLeases.boardTask")(function* (
  input: TaskLeaseRef,
  source: CompanySource,
) {
  const feed = yield* BanneretRelayFeed;
  const taskId = input.taskId;
  if (taskId !== undefined) {
    const state = Option.getOrUndefined(yield* Stream.runHead(feed.events(input.relayOrigin)));
    const task =
      allBoardCards(state?.board?.value).find((card) => card.task.id === taskId)?.task ??
      (yield* feed.task(input.relayOrigin, taskId)).value?.task;
    if (task) return task;
  }
  return yield* unavailable(`This task from ${source.title} is not on your board here.`);
});

const statusOf = (card: ProviderCard, busy: boolean): TaskLeaseStatus => {
  const { lease, lastRelease } = card;
  return {
    availability: "available",
    // The task contract has no "who am I", so the source decides whether a release is yours.
    viewer: null,
    lease: lease
      ? {
          holder: lease.holder.login,
          state: lease.state,
          since: lease.since ?? null,
          claimants: [lease.holder.login],
        }
      : null,
    lastRelease: lastRelease ? { ...lastRelease, by: lastRelease.by.login } : null,
    actions: { take: !lease, release: !!lease, finish: false, withdraw: false },
    busy,
  };
};

const off = (availability: TaskLeaseStatus["availability"], detail: string): TaskLeaseStatus => ({
  availability,
  detail,
  viewer: null,
  lease: null,
  lastRelease: null,
  actions: { take: false, release: false, finish: false, withdraw: false },
  busy: false,
});

const notShown = (source: CompanySource) =>
  `${source.title} does not show you this task, so take and release are off.`;

const asLeaseError = (error: SourceCallError) => unavailable(error.detail);

/** One write at a time for each task, in memory. */
const running = new Set<string>();
/**
 * Memory only: the idempotency key of a write the source never answered. The same press reuses it, so the
 * source can answer with the first outcome. It goes on a definite answer, another change, or after
 * `PENDING_MS`: an old key must not replay an old outcome.
 */
const pending = new Map<
  string,
  { readonly key: string; readonly change: string; readonly at: number }
>();
const PENDING_MS = 10 * 60_000;

const changeOf = (change: Change) => JSON.stringify(change);

const writeKey = (relayOrigin: string, source: CompanySource, taskId: string) =>
  JSON.stringify([relayOrigin, source.id, taskId]);

export const check = Effect.fn("BanneretProviderLeases.check")(function* (
  input: TaskLeaseRef,
  owner: ExternalTasks,
) {
  if ("off" in owner) return off("unsupported", owner.off);
  const { source } = owner;
  const task = yield* boardTask(input, source);
  return yield* Effect.gen(function* () {
    const session = yield* openSource(input.relayOrigin, source);
    const card = yield* findTask(session, task.id, task.ref);
    return card
      ? statusOf(card, running.has(writeKey(input.relayOrigin, source, task.id)))
      : off("no-permission", notShown(source));
  }).pipe(
    Effect.catch((error) => {
      const availability =
        error.kind === "signed_out"
          ? "signed-out"
          : error.kind === "refused"
            ? "no-permission"
            : error.kind === "shape"
              ? "unsupported"
              : undefined;
      return availability
        ? Effect.succeed(off(availability, error.detail))
        : Effect.fail(asLeaseError(error));
    }),
  );
});

type Change =
  | { readonly tool: "tasks_claim"; readonly args: object }
  | { readonly tool: "tasks_release"; readonly args: object };

const write = Effect.fn("BanneretProviderLeases.write")(function* (
  input: TaskLeaseRef,
  source: CompanySource,
  change: Change,
) {
  const task = yield* boardTask(input, source);
  const id = writeKey(input.relayOrigin, source, task.id);
  const verb = change.tool === "tasks_claim" ? "claim" : "release";
  if (running.has(id))
    return yield* new TaskLeaseError({
      reason: "busy",
      detail: `Another change to this task at ${source.title} is still running.`,
    });
  running.add(id);
  return yield* Effect.gen(function* () {
    const session = yield* openSource(input.relayOrigin, source).pipe(
      Effect.mapError(asLeaseError),
    );
    // Reading it with the person's own sign-in is what shows they may see it.
    const card = yield* findTask(session, task.id, task.ref).pipe(Effect.mapError(asLeaseError));
    if (!card) return yield* refused(notShown(source));
    const now = yield* Clock.currentTimeMillis;
    const fingerprint = changeOf(change);
    const earlier = pending.get(id);
    const entry =
      earlier && earlier.change === fingerprint && now - earlier.at < PENDING_MS
        ? earlier
        : { key: NodeCrypto.randomUUID(), change: fingerprint, at: now };
    pending.set(id, entry);
    // The task contract makes a repeat with this key the same call (docs/banneret/plugins.md, Tasks).
    const args = { ...change.args, taskId: card.task.id, idempotencyKey: entry.key };
    let repeated = entry === earlier;
    const first = yield* Effect.result(session.call(change.tool, args));
    let outcome = first;
    if (first._tag === "Failure" && first.failure.kind === "no_answer") {
      repeated = true;
      outcome = yield* Effect.result(
        openSource(input.relayOrigin, source).pipe(
          Effect.flatMap((again) => again.call(change.tool, args)),
        ),
      );
    }
    const unsure = `${source.title} did not answer. Your ${verb} may have gone through. Try again: a repeat is safe.`;
    if (outcome._tag === "Failure") {
      const error = outcome.failure;
      // Only the source's own refusal of this call says the write did not happen.
      if (error.kind === "tool") {
        pending.delete(id);
        return yield* refused(error.detail);
      }
      if (!repeated) {
        pending.delete(id);
        return yield* failed(error.detail);
      }
      return yield* failed(error.kind === "no_answer" ? unsure : `${unsure} ${error.detail}`);
    }
    const status = (outcome.success as { readonly status?: unknown }).status;
    const known =
      change.tool === "tasks_claim" ? ["claimed", "conflict"] : ["released", "not_holder"];
    if (typeof status !== "string" || !known.includes(status))
      return yield* failed(
        `${source.title} answered in a way the Hub does not understand. Your ${verb} may have gone through.`,
      );
    pending.delete(id);
    const after = yield* openSource(input.relayOrigin, source).pipe(
      Effect.flatMap((again) => readTask(again, card.task.id)),
      Effect.orElseSucceed(() => undefined),
    );
    return { status, repeated, after };
  }).pipe(Effect.ensuring(Effect.sync(() => running.delete(id))));
});

const unread = (source: CompanySource, said: string) =>
  off("unsupported", `${said} ${source.title} could not be read back. Open the task again.`);

export const take = Effect.fn("BanneretProviderLeases.take")(function* (
  input: TaskLeaseRef,
  owner: ExternalTasks,
) {
  if ("off" in owner) return yield* unavailable(owner.off);
  const { source } = owner;
  const { status, after } = yield* write(input, source, { tool: "tasks_claim", args: {} });
  const current = after
    ? statusOf(after, false)
    : unread(source, status === "claimed" ? "Your claim was accepted." : "");
  const holder = current.lease?.holder;
  const result: TaskLeaseResult =
    status === "claimed"
      ? { outcome: "taken", status: current }
      : {
          outcome: "lost",
          detail: holder
            ? `${source.title} says ${holder} holds this task.`
            : `${source.title} says someone else holds this task.`,
          status: current,
        };
  return result;
});

export const release = Effect.fn("BanneretProviderLeases.release")(function* (
  input: TaskLeaseReleaseInput,
  owner: ExternalTasks,
) {
  if ("off" in owner) return yield* unavailable(owner.off);
  const { source } = owner;
  const invalid = checkReleaseComment(input);
  if (invalid !== null) return yield* new TaskLeaseError({ reason: "invalid", detail: invalid });
  // The contract has one note. An Other reason's words and any follow-ups go in it, so nothing is lost.
  const reasonText = input.reason === "other" ? input.reasonText?.trim() : undefined;
  const note = [
    reasonText,
    input.note?.trim(),
    input.followUps?.length ? `Follow-ups: ${input.followUps.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const { status, repeated, after } = yield* write(input, source, {
    tool: "tasks_release",
    args: {
      reason: input.reason,
      freeToContinue: input.freeToContinue,
      ...(reasonText ? { reasonText } : {}),
      ...(note ? { note } : {}),
    },
  });
  if (status === "not_holder")
    return yield* refused(
      `${source.title} says you do not hold this task.${repeated ? " An earlier try may have released it." : ""}`,
    );
  const result: TaskLeaseResult = {
    outcome: "released",
    status: after ? statusOf(after, false) : unread(source, "Your release was accepted."),
  };
  return result;
});

/** Finish and Withdraw repair Banneret's own half-written claims. A company tracker has none. */
export const noRepair = (owner: ExternalTasks) =>
  Effect.fail(
    unavailable(
      "off" in owner
        ? owner.off
        : `${owner.source.title} owns claims here. There is nothing to finish or withdraw.`,
    ),
  );
