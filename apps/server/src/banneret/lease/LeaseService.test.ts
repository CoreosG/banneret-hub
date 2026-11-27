// @effect-diagnostics globalDate:off globalDateInEffect:off - the fake tracker writes ISO comment times.
import { describe, expect, it } from "@effect/vitest";
import type { TaskLeaseError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  addComment,
  addCommentAt,
  enrolledAs,
  EPOCH,
  leases,
  ME,
  newTracker,
  OTHER,
  ref,
} from "./leaseTracker.testkit.ts";

const failureOf = <A>(effect: Effect.Effect<A, TaskLeaseError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => ({ reason: error.reason, detail: error.detail })));

describe("LeaseService take", () => {
  it.effect("claims, assigns and labels a free task, reading every comment page", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker();
      for (let index = 0; index < 7; index++) addComment(tracker, OTHER, `Note ${index}`, 600);
      const service = yield* leases(tracker);
      const result = yield* service.take({ ...ref });
      expect(result.outcome).toBe("taken");
      expect(result.status.lease).toMatchObject({ holder: ME, state: "active" });
      expect(result.status.actions).toEqual({
        take: false,
        release: true,
        finish: false,
        withdraw: false,
      });
      expect(tracker.writes).toEqual([
        `comment claim: ${ME}/hub`,
        `update assignees=${ME} labels=claimed`,
      ]);
    }),
  );

  it.effect("ignores an edited claim: the task reads as free", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker();
      addCommentAt(tracker, OTHER, `claim: ${OTHER}/hub`, EPOCH - 30_000, 5_000);
      const service = yield* leases(tracker);
      const read = yield* service.check(ref);
      expect(read.lease).toBeNull();
      expect(tracker.writes).toEqual([]);
    }),
  );

  it.effect("fails the read when a claim is gone by the time its edit time is read", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker();
      addComment(tracker, OTHER, `claim: ${OTHER}/hub`, 30);
      tracker.gone.add(String(tracker.nextId - 1));
      const service = yield* leases(tracker);
      const failure = yield* failureOf(service.check(ref));
      expect(failure.reason).toBe("failed");
      expect(tracker.writes).toEqual([]);
    }),
  );

  it.effect("writes nothing when someone else holds it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker({ assignees: [OTHER], labels: ["claimed"] });
      addComment(tracker, OTHER, `claim: ${OTHER}/hub`, 30);
      const service = yield* leases(tracker);
      expect(yield* failureOf(service.take({ ...ref }))).toEqual({
        reason: "refused",
        detail: `${OTHER} holds this task.`,
      });
      expect(tracker.writes).toEqual([]);
    }),
  );

  it.effect("writes nothing without triage access, on the wrong account or without labels", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const noTriage = newTracker({
        permissions: { comment: true, labels: false, assignees: true },
      });
      const status = yield* (yield* leases(noTriage)).check(ref);
      expect(status.availability).toBe("no-permission");
      expect(status.detail).toBe(
        `Signed in as ${ME}. You need triage access on example-org/example-app to take tasks there. Ask a founder.`,
      );
      expect(status.actions.take).toBe(false);
      expect((yield* failureOf((yield* leases(noTriage)).take({ ...ref }))).reason).toBe(
        "unavailable",
      );

      const signedOut = yield* (yield* leases(newTracker({ viewer: null }))).check(ref);
      expect(signedOut.detail).toContain(`Sign in as ${ME}`);

      const wrongAccount = newTracker();
      const wrong = yield* leases(wrongAccount, enrolledAs(OTHER));
      expect(
        yield* failureOf(wrong.take({ ...ref, relayOrigin: "https://relay.example" })),
      ).toEqual({
        reason: "unavailable",
        detail: `The tracker is signed in as ${ME}, but the relay knows you as ${OTHER}.`,
      });

      const noLabels = newTracker({
        capabilities: { comment: true, labels: false, assignees: true },
      });
      expect((yield* (yield* leases(noLabels)).check(ref)).availability).toBe("unsupported");

      expect([...noTriage.writes, ...wrongAccount.writes, ...noLabels.writes]).toEqual([]);
    }),
  );

  it.effect(
    "refuses a call for a company this machine has not joined, before reading anything",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(EPOCH);
        const tracker = newTracker();
        // The default enrolment answers as a machine that never joined any relay.
        const service = yield* leases(tracker, Layer.empty);
        const forCompany = { ...ref, relayOrigin: "https://relay.example" };
        expect(yield* failureOf(service.take(forCompany))).toEqual({
          reason: "unavailable",
          detail: "This machine has not joined the company at https://relay.example.",
        });
        expect((yield* failureOf(service.check(forCompany))).reason).toBe("unavailable");
        expect(tracker.writes).toEqual([]);
      }),
  );

  it.effect("loses a race to an earlier claim and withdraws without touching claimed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker();
      tracker.beforeComment = () => {
        addComment(tracker, OTHER, `claim: ${OTHER}/hub`, 1);
        tracker.assignees = [OTHER];
        tracker.labels = ["claimed"];
      };
      const service = yield* leases(tracker);
      const result = yield* service.take({ ...ref });
      expect(result.outcome).toBe("lost");
      expect(result.detail).toBe(`${OTHER} took it first.`);
      expect(result.status.lease).toMatchObject({ holder: OTHER, state: "active" });
      expect(tracker.assignees).toEqual([OTHER]);
      expect(tracker.labels).toEqual(["claimed"]);
      expect(tracker.writes.at(-2)).toBe(`comment release: lost_claim · @${OTHER}`);
    }),
  );

  it.effect("breaks a same-second race by the numeric comment id, not the node id", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker();
      const at = new Date(EPOCH - 1000).toISOString();
      // The other claim has the lower REST id; its node id sorts later as a string.
      tracker.comments.push({
        id: "IC_zzz",
        author: { login: OTHER, name: null, avatarUrl: null },
        body: `claim: ${OTHER}/hub`,
        createdAt: at,
        url: "https://github.com/example-org/example-app/issues/7#issuecomment-998",
      });
      tracker.comments.push({
        id: "IC_aaa",
        author: { login: ME, name: null, avatarUrl: null },
        body: `claim: ${ME}/hub`,
        createdAt: at,
        url: "https://github.com/example-org/example-app/issues/7#issuecomment-1002",
      });
      tracker.assignees = [ME, OTHER];
      tracker.labels = ["claimed"];
      const status = yield* (yield* leases(tracker)).check(ref);
      expect(status.lease).toMatchObject({
        holder: OTHER,
        state: "conflict",
        claimants: [OTHER, ME],
      });
      expect(status.actions).toEqual({
        take: false,
        release: false,
        finish: false,
        withdraw: true,
      });
    }),
  );

  it.effect(
    "reports incomplete when the lost claim cannot be withdrawn, and the loser withdraws later",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(EPOCH);
        const tracker = newTracker({ refuseComments: /lost_claim/ });
        tracker.beforeComment = () => {
          addComment(tracker, OTHER, `claim: ${OTHER}/hub`, 1);
          tracker.assignees = [OTHER];
          tracker.labels = ["claimed"];
        };
        const service = yield* leases(tracker);
        const result = yield* service.take({ ...ref });
        expect(result.outcome).toBe("incomplete");
        expect(result.status.lease).toMatchObject({ holder: OTHER, state: "conflict" });
        expect(result.status.actions.withdraw).toBe(true);
        tracker.refuseComments = null;
        const withdrawn = yield* service.withdraw(ref);
        expect(withdrawn.outcome).toBe("withdrawn");
        expect(withdrawn.status.lease).toMatchObject({ holder: OTHER, state: "active" });
        expect(tracker.assignees).toEqual([OTHER]);
        expect(tracker.labels).toEqual(["claimed"]);
      }),
  );

  it.effect("withdraws the take when assigning fails three times", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker({ failUpdates: 3 });
      const result = yield* (yield* leases(tracker)).take({ ...ref });
      expect(result.outcome).toBe("withdrawn");
      expect(result.status.lease).toBeNull();
      expect(result.status.lastRelease).toBeNull();
      expect(tracker.writes).toEqual([`comment claim: ${ME}/hub`, "comment release: take_failed"]);
    }),
  );

  it.effect("leaves an incomplete take when the withdrawal fails too, then finishes it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker({ failUpdates: 3, refuseComments: /take_failed/ });
      const service = yield* leases(tracker);
      const result = yield* service.take({ ...ref });
      expect(result.outcome).toBe("incomplete");
      expect(tracker.writes).toEqual([`comment claim: ${ME}/hub`]);
      // Inside the settle window the claim still reads as active; past it, as incomplete.
      expect(result.status.lease?.state).toBe("active");
      yield* TestClock.adjust("2 minutes");
      const stuck = yield* service.check(ref);
      expect(stuck.lease).toMatchObject({ holder: ME, state: "incomplete" });
      expect(stuck.actions).toEqual({ take: false, release: false, finish: true, withdraw: true });
      const finished = yield* service.finish(ref);
      expect(finished.outcome).toBe("taken");
      expect(finished.status.lease).toMatchObject({ holder: ME, state: "active" });
      expect(tracker.assignees).toEqual([ME]);
      expect(tracker.labels).toEqual(["claimed"]);
    }),
  );

  it.effect("withdraws an incomplete take", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker({ assignees: [ME] });
      addComment(tracker, ME, `claim: ${ME}/hub`, 120);
      const service = yield* leases(tracker);
      expect((yield* service.check(ref)).lease?.state).toBe("incomplete");
      const result = yield* service.withdraw(ref);
      expect(result.outcome).toBe("withdrawn");
      expect(result.status.lease).toBeNull();
      expect(tracker.assignees).toEqual([]);
      expect(tracker.writes[0]).toBe("comment release: take_failed");
    }),
  );

  it.effect("a failed claim comment leaves the task untouched", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker({ failComments: 1 });
      expect((yield* failureOf((yield* leases(tracker)).take({ ...ref }))).reason).toBe("failed");
      expect(tracker.writes).toEqual([]);
      expect(tracker.assignees).toEqual([]);
    }),
  );

  it.effect("says plainly when the tracker's rate limit stops a take", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker({ rateLimited: true });
      expect(yield* failureOf((yield* leases(tracker)).take({ ...ref }))).toEqual({
        reason: "failed",
        detail: "The tracker's rate limit is used up. Try again in a few minutes.",
      });
      expect(tracker.writes).toEqual([]);
    }),
  );

  it.effect("withdraw clears a leftover assignee with no claim, and refuses an active holder", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const leftover = newTracker({ assignees: [ME], labels: ["claimed"] });
      addComment(leftover, ME, `claim: ${ME}/hub`, 300);
      addComment(leftover, ME, "release: take_failed", 200);
      const service = yield* leases(leftover);
      expect((yield* service.check(ref)).lease).toMatchObject({
        holder: ME,
        state: "incomplete",
        since: null,
      });
      const cleared = yield* service.withdraw(ref);
      expect(cleared.outcome).toBe("withdrawn");
      expect(cleared.status.lease).toBeNull();
      expect(leftover.writes).toEqual(["update assignees= labels="]);

      const active = newTracker({ assignees: [ME], labels: ["claimed"] });
      addComment(active, ME, `claim: ${ME}/hub`, 300);
      expect(yield* failureOf((yield* leases(active)).withdraw(ref))).toEqual({
        reason: "refused",
        detail: "You hold this task. Release it instead.",
      });
      expect(active.writes).toEqual([]);
    }),
  );

  it.effect("removes paused only from open pull requests when it wins", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker({
        prs: [
          { number: 12, isDraft: true, state: "open", labels: ["paused"] },
          { number: 9, isDraft: false, state: "closed", labels: ["paused"] },
        ],
      });
      const result = yield* (yield* leases(tracker)).take({ ...ref });
      expect(result.outcome).toBe("taken");
      expect(tracker.prs.map((pr) => pr.labels)).toEqual([[], ["paused"]]);
    }),
  );

  it.effect("refuses a second operation on the same task while one runs", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = newTracker();
      const assigned = yield* Deferred.make<void>();
      tracker.afterUpdate = Deferred.succeed(assigned, undefined).pipe(Effect.asVoid);
      const service = yield* leases(tracker, enrolledAs(ME), "10 seconds");
      const first = yield* Effect.forkChild(service.take({ ...ref }));
      // Assigned, the take waits for its read-back on the TestClock; until then it holds the task.
      yield* Deferred.await(assigned);
      expect((yield* failureOf(service.take({ ...ref }))).reason).toBe("busy");
      expect((yield* service.check(ref)).busy).toBe(true);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(first)).outcome).toBe("taken");
      expect((yield* service.check(ref)).busy).toBe(false);
    }),
  );
});

describe("LeaseService release", () => {
  const held = () => {
    const tracker = newTracker({
      assignees: [ME],
      labels: ["claimed", "bug"],
      prs: [{ number: 12, isDraft: true, state: "open", labels: [] }],
    });
    addComment(tracker, ME, `claim: ${ME}/hub`, 300);
    return tracker;
  };

  it.effect("writes the reason line first, then unassigns and unlabels", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = held();
      const result = yield* (yield* leases(tracker)).release({
        ...ref,
        reason: "out_of_usage",
        freeToContinue: true,
        note: "**Goal:** Ship it.\n**Done:** API.\n**Next:** Button.",
        followUps: ["#51"],
      });
      expect(result.outcome).toBe("released");
      expect(tracker.comments.at(-1)?.body).toBe(
        "release: out_of_usage · free to continue\n**Goal:** Ship it.\n**Done:** API.\n**Next:** Button.\nFollow-ups: #51",
      );
      expect(tracker.assignees).toEqual([]);
      expect(tracker.labels).toEqual(["bug"]);
      expect(tracker.prs[0]?.labels).toEqual(["paused"]);
      expect(result.status.lease).toBeNull();
      expect(result.status.lastRelease).toMatchObject({
        by: ME,
        reason: "out_of_usage",
        freeToContinue: true,
      });
      expect(result.status.actions.take).toBe(true);
    }),
  );

  it.effect("finishes a release whose draft pull request label failed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = held();
      tracker.failPrLabels = 1;
      const service = yield* leases(tracker);
      const first = yield* service.release({ ...ref, reason: "blocked", freeToContinue: true });
      expect(first.outcome).toBe("incomplete");
      expect(first.status.actions.finish).toBe(true);
      expect(tracker.prs[0]?.labels).toEqual([]);
      const finished = yield* service.finish(ref);
      expect(finished.outcome).toBe("released");
      expect(tracker.prs[0]?.labels).toEqual(["paused"]);
      expect(tracker.writes.filter((write) => write.startsWith("comment"))).toHaveLength(1);
    }),
  );

  it.effect("answers take and release with a status that does not count their own lock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const service = yield* leases(newTracker());
      const taken = yield* service.take({ ...ref });
      expect(taken.outcome).toBe("taken");
      expect(taken.status.busy).toBe(false);
      expect(taken.status.actions.release).toBe(true);
      const released = yield* service.release({ ...ref, reason: "done", freeToContinue: false });
      expect(released.outcome).toBe("released");
      expect(released.status.busy).toBe(false);
    }),
  );

  it.effect("refuses an invalid release and a release by someone who does not hold it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = held();
      const service = yield* leases(tracker);
      expect(
        (yield* failureOf(service.release({ ...ref, reason: "other", freeToContinue: false })))
          .reason,
      ).toBe("invalid");
      const notMine = newTracker({ assignees: [OTHER], labels: ["claimed"] });
      addComment(notMine, OTHER, `claim: ${OTHER}/hub`, 300);
      expect(
        yield* failureOf(
          (yield* leases(notMine)).release({ ...ref, reason: "done", freeToContinue: false }),
        ),
      ).toEqual({ reason: "refused", detail: "You do not hold this task." });
      expect([...tracker.writes, ...notMine.writes]).toEqual([]);
    }),
  );

  it.effect("reports incomplete when unassigning fails, and a retry posts no second comment", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = held();
      tracker.failUpdates = 1;
      const service = yield* leases(tracker);
      const first = yield* service.release({ ...ref, reason: "done", freeToContinue: false });
      expect(first.outcome).toBe("incomplete");
      expect(tracker.assignees).toEqual([ME]);
      const retry = yield* service.release({ ...ref, reason: "done", freeToContinue: false });
      expect(retry.outcome).toBe("released");
      expect(tracker.writes.filter((write) => write.startsWith("comment"))).toEqual([
        "comment release: done",
      ]);
      expect(tracker.assignees).toEqual([]);
    }),
  );

  it.effect("a failed release comment leaves the task untouched", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = held();
      tracker.failComments = 1;
      const failure = yield* failureOf(
        (yield* leases(tracker)).release({ ...ref, reason: "done", freeToContinue: false }),
      );
      expect(failure.reason).toBe("failed");
      expect(tracker.writes).toEqual([]);
      expect(tracker.assignees).toEqual([ME]);
    }),
  );
});
