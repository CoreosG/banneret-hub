// @effect-diagnostics globalDate:off globalDateInEffect:off - the fake tracker writes ISO comment times.
import { describe, expect, it } from "@effect/vitest";
import {
  type IssueComment,
  type IssueDetail,
  type IssueRef,
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
  type TaskLeaseError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as IssueService from "../../issue/IssueService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as BanneretEnrolment from "../relay/Enrolment.ts";
import * as CommentEdits from "./CommentEdits.ts";
import * as LeaseService from "./LeaseService.ts";

// An in-memory issue behind the issue and pull request services: the boundary LeaseService writes through.
// Nothing here reaches a real tracker.

const ME = "ada-example";
const OTHER = "bo-example";
const PAGE = 3;
/** Every test starts its TestClock here. */
const EPOCH = Date.UTC(2026, 10, 20, 10);

const ref: IssueRef = {
  projectId: ProjectId.make("project-1"),
  tracker: IssueTrackerKind.make("github"),
  scope: "example-org/example-app",
  key: "7",
};

interface FakeTracker {
  comments: Array<IssueComment>;
  assignees: Array<string>;
  labels: Array<string>;
  prs: Array<{ number: number; isDraft: boolean; state: "open" | "closed"; labels: Array<string> }>;
  viewer: string | null;
  capabilities: { comment: boolean; labels: boolean; assignees: boolean };
  permissions: { comment: boolean; labels: boolean; assignees: boolean };
  /** Each write of that kind fails while the count is above zero. */
  failComments: number;
  /** Every comment fails as the tracker's rate limit. */
  rateLimited: boolean;
  failUpdates: number;
  failPrLabels: number;
  /** Comments whose line 1 matches are refused. */
  refuseComments: RegExp | null;
  /** Runs before a comment lands, as another person's Hub would. */
  beforeComment: ((body: string) => void) | null;
  /** Runs after each successful update. */
  afterUpdate: Effect.Effect<void>;
  writes: Array<string>;
  nextId: number;
  /** Milliseconds after its creation each edited comment was edited, by REST id. */
  edits: Map<string, number>;
  /** REST ids the edit-time read no longer finds, as after a deletion. */
  gone: Set<string>;
}

const newTracker = (overrides: Partial<FakeTracker> = {}): FakeTracker => ({
  comments: [],
  assignees: [],
  labels: [],
  prs: [],
  viewer: ME,
  capabilities: { comment: true, labels: true, assignees: true },
  permissions: { comment: true, labels: true, assignees: true },
  failComments: 0,
  rateLimited: false,
  failUpdates: 0,
  failPrLabels: 0,
  refuseComments: null,
  beforeComment: null,
  afterUpdate: Effect.void,
  writes: [],
  nextId: 5000,
  edits: new Map(),
  gone: new Set(),
  ...overrides,
});

const addComment = (tracker: FakeTracker, author: string, body: string, ageSeconds = 0) =>
  addCommentAt(tracker, author, body, EPOCH - ageSeconds * 1000);

const addCommentAt = (
  tracker: FakeTracker,
  author: string,
  body: string,
  atMs: number,
  editedAfterMs = 0,
) => {
  const id = tracker.nextId++;
  tracker.comments.push({
    id: `IC_node${id}`,
    author: { login: author, name: null, avatarUrl: null },
    body,
    createdAt: new Date(atMs).toISOString(),
    url: `https://github.com/example-org/example-app/issues/7#issuecomment-${id}`,
  });
  if (editedAfterMs > 0) tracker.edits.set(String(id), editedAfterMs);
};

const refused = (operation: string) =>
  Effect.fail(new IssueOperationError({ operation, detail: `The ${operation} was refused.` }));

const issueService = (tracker: FakeTracker) =>
  ({
    detail: () =>
      Effect.sync(() => {
        // Newest page first, older pages behind a cursor, as GitHub serves them.
        const ordered = [...tracker.comments];
        const page = ordered.slice(-PAGE);
        return {
          scope: ref.scope,
          writable: true,
          viewer: tracker.viewer,
          capabilities: { ...tracker.capabilities },
          viewerPermissions: { ...tracker.permissions, setState: true, edit: true },
          assignees: tracker.assignees.map((login) => ({ login, name: null, avatarUrl: null })),
          labels: tracker.labels.map((name) => ({ name, color: null })),
          comments: page,
          commentsCursor: ordered.length > PAGE ? String(ordered.length - PAGE) : null,
          linkedPullRequests: tracker.prs.map((pr) => ({
            repository: ref.scope,
            number: pr.number,
            title: `PR ${pr.number}`,
            url: `https://github.com/example-org/example-app/pull/${pr.number}`,
            state: pr.state,
            isDraft: pr.isDraft,
            closesIssue: true,
          })),
        } as unknown as IssueDetail;
      }),
    comments: (input: { cursor: string }) =>
      Effect.sync(() => {
        const end = Number(input.cursor);
        const start = Math.max(0, end - PAGE);
        return {
          comments: tracker.comments.slice(start, end),
          nextCursor: start > 0 ? String(start) : null,
        };
      }),
    comment: (input: { body: string }) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        if (tracker.rateLimited) {
          return Effect.fail(
            new IssueOperationError({
              operation: "comment",
              detail: "API rate limit exceeded.",
              reason: "rate-limited",
            }),
          );
        }
        if (tracker.failComments > 0 || tracker.refuseComments?.test(input.body) === true) {
          tracker.failComments = Math.max(0, tracker.failComments - 1);
          return refused("comment");
        }
        tracker.beforeComment?.(input.body);
        tracker.beforeComment = null;
        addCommentAt(tracker, tracker.viewer ?? "", input.body, now);
        tracker.writes.push(`comment ${input.body.split("\n")[0]}`);
        return Effect.void;
      }),
    update: (input: { labels?: ReadonlyArray<string>; assignees?: ReadonlyArray<string> }) =>
      Effect.suspend(() => {
        if (tracker.failUpdates > 0) {
          tracker.failUpdates--;
          return refused("update");
        }
        if (input.labels !== undefined) tracker.labels = [...input.labels];
        if (input.assignees !== undefined) tracker.assignees = [...input.assignees];
        tracker.writes.push(
          `update assignees=${tracker.assignees.join(",")} labels=${tracker.labels.join(",")}`,
        );
        return tracker.afterUpdate;
      }),
  }) as unknown as IssueService.IssueService["Service"];

const pullRequestService = (tracker: FakeTracker) =>
  ({
    detail: (input: { number: number }) =>
      Effect.sync(() => ({
        labels: (tracker.prs.find((pr) => pr.number === input.number)?.labels ?? []).map(
          (name) => ({ name, color: null }),
        ),
      })),
    setLabels: (input: { number: number; labels: ReadonlyArray<string>; applied: boolean }) =>
      Effect.suspend(() => {
        if (tracker.failPrLabels > 0) {
          tracker.failPrLabels--;
          return refused("setLabels");
        }
        const pr = tracker.prs.find((candidate) => candidate.number === input.number);
        if (pr === undefined) return refused("setLabels");
        pr.labels = input.applied
          ? [...new Set([...pr.labels, ...input.labels])]
          : pr.labels.filter((name) => !input.labels.includes(name));
        tracker.writes.push(
          `pr ${pr.number} ${input.applied ? "+" : "-"}${input.labels.join(",")}`,
        );
        return Effect.void;
      }),
  }) as unknown as PullRequestService.PullRequestService["Service"];

/** GitHub's REST times for the asked comments the tracker still has. */
const commentEdits = (tracker: FakeTracker) =>
  CommentEdits.CommentEdits.of({
    read: (input) =>
      Effect.sync(() => {
        const times = new Map<string, { createdAt: string; updatedAt: string }>();
        for (const comment of tracker.comments) {
          const id = /#issuecomment-(\d+)$/.exec(comment.url ?? "")?.[1];
          if (id === undefined || !input.commentIds.includes(id) || tracker.gone.has(id)) continue;
          const created = Date.parse(comment.createdAt);
          times.set(id, {
            createdAt: comment.createdAt,
            updatedAt: new Date(created + (tracker.edits.get(id) ?? 0)).toISOString(),
          });
        }
        return times;
      }),
  });

const enrolledAs = (login: string, role = "limited_staff") =>
  Layer.succeed(BanneretEnrolment.BanneretEnrolment, {
    ...BanneretEnrolment.BanneretEnrolment.defaultValue(),
    status: (relayOrigin: string) =>
      Effect.succeed({
        state: "configured" as const,
        workspaceId: "ent-0000000000000000",
        relayOrigin,
        me: { login, role },
      }),
  });

const leases = (
  tracker: FakeTracker,
  enrolment: Layer.Layer<never> = Layer.empty,
  readBackDelay: Duration.Input = 0,
) =>
  Effect.service(LeaseService.LeaseService).pipe(
    Effect.provide(
      LeaseService.layerWith({ readBackDelay }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(IssueService.IssueService, issueService(tracker)),
            Layer.succeed(PullRequestService.PullRequestService, pullRequestService(tracker)),
            Layer.succeed(CommentEdits.CommentEdits, commentEdits(tracker)),
            enrolment,
          ),
        ),
      ),
    ),
  );

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
      expect(status.detail).toBe("Needs triage access to example-org/example-app.");
      expect(status.actions.take).toBe(false);
      expect((yield* failureOf((yield* leases(noTriage)).take({ ...ref }))).reason).toBe(
        "unavailable",
      );

      const wrongAccount = newTracker();
      const wrong = yield* leases(wrongAccount, enrolledAs(OTHER));
      expect(
        yield* failureOf(wrong.take({ ...ref, relayOrigin: "https://relay.example" })),
      ).toEqual({
        reason: "unavailable",
        detail: `The tracker is signed in as ${ME}, but the relay knows you as ${OTHER}.`,
      });
      // Without a relay (a Personal workspace) no relay's person is checked.
      expect((yield* wrong.check(ref)).availability).toBe("available");

      const noLabels = newTracker({
        capabilities: { comment: true, labels: false, assignees: true },
      });
      expect((yield* (yield* leases(noLabels)).check(ref)).availability).toBe("unsupported");

      expect([...noTriage.writes, ...wrongAccount.writes, ...noLabels.writes]).toEqual([]);
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

  it.effect("removes paused from the task's open pull request when it wins", () =>
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
      const service = yield* leases(tracker, Layer.empty, "10 seconds");
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

  it.effect("writes the reason line first, then unassigns, unlabels and pauses the draft", () =>
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

  it.effect("finishes a release whose draft pull request label failed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(EPOCH);
      const tracker = held();
      tracker.failPrLabels = 1;
      const service = yield* leases(tracker);
      const first = yield* service.release({ ...ref, reason: "blocked", freeToContinue: true });
      expect(first.outcome).toBe("incomplete");
      expect(tracker.prs[0]?.labels).toEqual([]);
      const finished = yield* service.finish(ref);
      expect(finished.outcome).toBe("released");
      expect(tracker.prs[0]?.labels).toEqual(["paused"]);
      expect(tracker.writes.filter((write) => write.startsWith("comment"))).toHaveLength(1);
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
