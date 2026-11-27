// Take and release a task on its work tracker, on the person's own login, through the issue and pull request
// services. The tracker holds the state; this keeps one in-memory operation per task and nothing on disk. The
// state table is in docs/banneret/relay-v1/README.md, "How the Hub writes".
import {
  foldLease,
  formatClaimLine,
  formatReleaseComment,
  formatWithdrawLine,
  checkReleaseComment,
  LEASE_LABEL_CLAIMED,
  LEASE_LABEL_PAUSED,
  type IssueComment,
  type IssueDetail,
  IssueOperationError,
  type IssueRef,
  IssueUnavailableError,
  type LeaseFoldResult,
  TASK_LEASE_WS_METHODS,
  TaskLeaseError,
  type TaskLeaseReleaseInput,
  type TaskLeaseResult,
  type TaskLeaseStatus,
  type TaskLeaseTakeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as IssueService from "../../issue/IssueService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as BanneretEnrolment from "../relay/Enrolment.ts";

/** How long a take waits before reading back who claimed first. */
const READ_BACK_DELAY = Duration.seconds(10);
/** Older comment pages read before giving up; 100 comments each. */
const MAX_COMMENT_PAGES = 50;
const UPDATE_ATTEMPTS = 3;

export interface LeaseServiceShape {
  readonly check: (ref: IssueRef) => Effect.Effect<TaskLeaseStatus, TaskLeaseError>;
  readonly take: (input: TaskLeaseTakeInput) => Effect.Effect<TaskLeaseResult, TaskLeaseError>;
  readonly release: (
    input: TaskLeaseReleaseInput,
  ) => Effect.Effect<TaskLeaseResult, TaskLeaseError>;
  readonly finish: (ref: IssueRef) => Effect.Effect<TaskLeaseResult, TaskLeaseError>;
  readonly withdraw: (ref: IssueRef) => Effect.Effect<TaskLeaseResult, TaskLeaseError>;
}

const notRunning = Effect.fail(
  new TaskLeaseError({ reason: "unavailable", detail: "Take and release are not running." }),
);

/** A reference with an inert default, so layers built without it (tests, tools) need no stub. */
export class LeaseService extends Context.Reference<LeaseServiceShape>(
  "t3/banneret/lease/LeaseService",
  {
    defaultValue: () => ({
      check: () => notRunning,
      take: () => notRunning,
      release: () => notRunning,
      finish: () => notRunning,
      withdraw: () => notRunning,
    }),
  },
) {}

export interface LeaseServiceOptions {
  readonly readBackDelay: Duration.Input;
}

/** The fields of a reference that name the task; the project only says whose credentials serve it. */
const issueRefOf = (ref: IssueRef): IssueRef => ({
  projectId: ref.projectId,
  tracker: ref.tracker,
  ...(ref.host === undefined ? {} : { host: ref.host }),
  scope: ref.scope,
  key: ref.key,
});

const taskKey = (ref: IssueRef) =>
  [ref.tracker, ref.host ?? "", ref.scope, ref.key].map((part) => part.toLowerCase()).join(" ");

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * On GitHub the comment url ends in `#issuecomment-<databaseId>`: the numeric id every reader of the protocol
 * breaks a same-second tie with. Other trackers keep their own id.
 */
const protocolCommentId = (comment: IssueComment): string =>
  /#issuecomment-(\d+)$/.exec(comment.url ?? "")?.[1] ?? comment.id;

interface Snapshot {
  readonly detail: IssueDetail;
  readonly fold: LeaseFoldResult;
  readonly viewer: string | null;
  readonly availability: TaskLeaseStatus["availability"];
  readonly unavailableDetail?: string;
}

const isOperationError = Schema.is(IssueOperationError);
const isUnavailableError = Schema.is(IssueUnavailableError);

/** One plain sentence for a tracker failure; people and agent tools read it as the reason. */
const describeError = (error: unknown): string => {
  if (isOperationError(error)) {
    if (error.reason === "rate-limited") {
      return "The tracker's rate limit is used up. Try again in a few minutes.";
    }
    if (error.reason === "read-only") return "The tracker allows only reading this issue.";
    if (error.reason === "not-found") return "The tracker could not find this issue.";
    return `The tracker refused the change: ${error.detail.replace(/\.?$/, ".")}`;
  }
  if (isUnavailableError(error)) {
    return `The tracker is unavailable. ${error.message}`;
  }
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "The tracker refused the request.";
};

const make = Effect.fn("LeaseService.make")(function* (options: Partial<LeaseServiceOptions> = {}) {
  const issues = yield* IssueService.IssueService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const enrolment = yield* BanneretEnrolment.BanneretEnrolment;
  const readBackDelay = options.readBackDelay ?? READ_BACK_DELAY;
  // The one operation running per task. In memory only; a restart forgets it, and the tracker keeps the truth.
  const operations = new Map<string, string>();

  const failed = (error: unknown) =>
    new TaskLeaseError({ reason: "failed", detail: describeError(error) });

  const read = Effect.fn("LeaseService.read")(function* (ref: IssueRef) {
    const detail = yield* issues.detail(ref).pipe(Effect.mapError(failed));
    const comments = [...detail.comments];
    let cursor = detail.commentsCursor;
    for (let page = 0; cursor !== null; page++) {
      if (page >= MAX_COMMENT_PAGES) {
        return yield* new TaskLeaseError({
          reason: "failed",
          detail: "This issue has too many comments to read its lease.",
        });
      }
      const next = yield* issues.comments({ ...ref, cursor }).pipe(Effect.mapError(failed));
      comments.push(...next.comments);
      cursor = next.nextCursor;
    }
    const status = yield* enrolment.status;
    const me = status.me;
    const now = yield* DateTime.now;
    const fold = foldLease({
      comments: comments.map((comment) => ({
        id: protocolCommentId(comment),
        author: comment.author?.login ?? null,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        body: comment.body,
      })),
      assignees: detail.assignees.map((actor) => actor.login),
      labels: detail.labels.map((label) => label.name),
      // The Hub knows only its own person's role, so it sees no other founder's release.
      founders: me !== undefined && me.role === "founder" ? [me.login] : [],
      now: DateTime.formatIso(now),
    });
    const viewer = detail.viewer;
    const can = detail.capabilities;
    const may = detail.viewerPermissions;
    const base = { detail, fold, viewer };
    if (!can.comment || !can.labels || !can.assignees) {
      return {
        ...base,
        availability: "unsupported",
        unavailableDetail:
          "This tracker cannot comment, label and assign, so take and release are off.",
      } satisfies Snapshot;
    }
    if (!detail.writable) {
      return {
        ...base,
        availability: "read-only",
        unavailableDetail: "This issue is outside the project's repositories.",
      } satisfies Snapshot;
    }
    if (viewer === null) {
      return {
        ...base,
        availability: "signed-out",
        unavailableDetail: "Sign in to the tracker to take tasks.",
      } satisfies Snapshot;
    }
    if (me !== undefined && !same(me.login, viewer)) {
      return {
        ...base,
        availability: "wrong-account",
        unavailableDetail: `The tracker is signed in as ${viewer}, but the relay knows you as ${me.login}.`,
      } satisfies Snapshot;
    }
    if (!may.comment || !may.labels || !may.assignees) {
      return {
        ...base,
        availability: "no-permission",
        unavailableDetail: `Needs triage access to ${detail.scope}.`,
      } satisfies Snapshot;
    }
    return { ...base, availability: "available" } satisfies Snapshot;
  });

  /** The last counted release, when it ended the viewer's own claim and nothing stands after it. */
  const ownRelease = (snapshot: Snapshot) => {
    const last = snapshot.fold.releases.at(-1);
    return snapshot.fold.lastRelease !== null &&
      last !== undefined &&
      snapshot.viewer !== null &&
      same(last.holder, snapshot.viewer)
      ? last
      : null;
  };

  const actionsOf = (snapshot: Snapshot): TaskLeaseStatus["actions"] => {
    const viewer = snapshot.viewer;
    const lease = snapshot.fold.lease;
    if (snapshot.availability !== "available" || viewer === null) {
      return { take: false, release: false, finish: false, withdraw: false };
    }
    const position = lease?.claimants.findIndex((login) => same(login, viewer)) ?? -1;
    const incomplete = lease?.state === "incomplete" && same(lease.holder, viewer);
    return {
      take: lease === null,
      release: position === 0 && lease?.state !== "incomplete",
      finish: incomplete && (position === 0 || ownRelease(snapshot) !== null),
      withdraw: incomplete || position > 0,
    };
  };

  const statusOf = (snapshot: Snapshot, ref: IssueRef): TaskLeaseStatus => ({
    availability: snapshot.availability,
    ...(snapshot.unavailableDetail === undefined ? {} : { detail: snapshot.unavailableDetail }),
    viewer: snapshot.viewer,
    lease: snapshot.fold.lease,
    lastRelease: snapshot.fold.lastRelease,
    actions: actionsOf(snapshot),
    busy: operations.has(taskKey(ref)),
  });

  const requireAvailable = (snapshot: Snapshot) =>
    snapshot.availability === "available" && snapshot.viewer !== null
      ? Effect.succeed(snapshot.viewer)
      : Effect.fail(
          new TaskLeaseError({
            reason: "unavailable",
            detail: snapshot.unavailableDetail ?? "Take and release are unavailable here.",
          }),
        );

  /** Runs one operation on a task, refusing a second one that overlaps it. */
  const exclusive = <A>(
    ref: IssueRef,
    kind: string,
    effect: Effect.Effect<A, TaskLeaseError>,
  ): Effect.Effect<A, TaskLeaseError> =>
    Effect.suspend(() => {
      const key = taskKey(ref);
      const running = operations.get(key);
      if (running !== undefined) {
        return Effect.fail(
          new TaskLeaseError({
            reason: "busy",
            detail: `A ${running} is already running on this task.`,
          }),
        );
      }
      operations.set(key, kind);
      return effect.pipe(Effect.ensuring(Effect.sync(() => operations.delete(key))));
    });

  /** One step that may fail without failing the operation: the detail of the failure, or null. */
  const attempt = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<string | null> =>
    Effect.match(effect, { onFailure: describeError, onSuccess: () => null });

  const comment = (ref: IssueRef, body: string) => issues.comment({ ...ref, body });

  /** Re-reads the issue and writes only the assignee and label sets that change. */
  const reconcile = Effect.fn("LeaseService.reconcile")(function* (
    ref: IssueRef,
    change: (current: {
      readonly assignees: ReadonlyArray<string>;
      readonly labels: ReadonlyArray<string>;
    }) => { readonly assignees: ReadonlyArray<string>; readonly labels: ReadonlyArray<string> },
  ) {
    const detail = yield* issues.detail(ref);
    const current = {
      assignees: detail.assignees.map((actor) => actor.login),
      labels: detail.labels.map((label) => label.name),
    };
    const next = change(current);
    const differs = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
      a.length !== b.length || a.some((name) => !b.some((other) => same(name, other)));
    const assignees = differs(next.assignees, current.assignees) ? next.assignees : undefined;
    const labels = differs(next.labels, current.labels) ? next.labels : undefined;
    if (assignees === undefined && labels === undefined) return;
    yield* issues.update({
      ...ref,
      ...(assignees === undefined ? {} : { assignees }),
      ...(labels === undefined ? {} : { labels }),
    });
  });

  const withLabel = (labels: ReadonlyArray<string>, label: string) =>
    labels.some((name) => same(name, label)) ? labels : [...labels, label];
  const withoutName = (names: ReadonlyArray<string>, name: string) =>
    names.filter((other) => !same(other, name));

  /**
   * Adds or removes `paused` on the task's open pull requests (`draftsOnly` for a release). The pull request
   * API, not the issue `update`: GitHub's issue tracker resolves a number as an Issue and refuses a pull request.
   */
  const setPaused = Effect.fn("LeaseService.setPaused")(function* (
    ref: IssueRef,
    applied: boolean,
  ) {
    const detail = yield* issues.detail(ref);
    const targets = detail.linkedPullRequests.filter(
      (pr) => pr.state === "open" && (!applied || pr.isDraft),
    );
    for (const pr of targets) {
      const prRef = {
        projectId: ref.projectId,
        ...(ref.host === undefined ? {} : { host: ref.host }),
        repository: pr.repository,
        number: pr.number,
      };
      const current = yield* pullRequests.detail(prRef);
      const has = current.labels.some((label) => same(label.name, LEASE_LABEL_PAUSED));
      // Removing a label the pull request lacks is a 404 on GitHub, so only change what differs.
      if (has === applied) continue;
      yield* pullRequests.setLabels({ ...prRef, labels: [LEASE_LABEL_PAUSED], applied });
    }
  });

  const result = Effect.fn("LeaseService.result")(function* (
    ref: IssueRef,
    outcome: TaskLeaseResult["outcome"],
    detail?: string,
  ) {
    const snapshot = yield* read(ref);
    return {
      outcome,
      ...(detail === undefined ? {} : { detail }),
      status: statusOf(snapshot, ref),
    } satisfies TaskLeaseResult;
  });

  /** Assign the holder and add `claimed`, re-reading before each of up to three tries. */
  const assignHolder = (ref: IssueRef, viewer: string) =>
    reconcile(ref, (current) => ({
      assignees: current.assignees.some((name) => same(name, viewer))
        ? current.assignees
        : [...current.assignees, viewer],
      labels: withLabel(current.labels, LEASE_LABEL_CLAIMED),
    })).pipe(Effect.retry({ times: UPDATE_ATTEMPTS - 1 }));

  /** The tracker side of a release, after its comment: unassign, unlabel, pause the draft. */
  const settleRelease = Effect.fn("LeaseService.settleRelease")(function* (
    ref: IssueRef,
    viewer: string,
    othersStanding: boolean,
  ) {
    const unassigned = yield* attempt(
      reconcile(ref, (current) => ({
        assignees: withoutName(current.assignees, viewer),
        labels: othersStanding ? current.labels : withoutName(current.labels, LEASE_LABEL_CLAIMED),
      })),
    );
    if (unassigned !== null) {
      return yield* result(
        ref,
        "incomplete",
        `The release comment is posted, but unassigning failed: ${unassigned} Finish retries it.`,
      );
    }
    const paused = yield* attempt(setPaused(ref, true));
    if (paused !== null) {
      return yield* result(
        ref,
        "incomplete",
        `Released, but adding paused to the draft pull request failed: ${paused} Finish retries it.`,
      );
    }
    return yield* result(ref, "released");
  });

  /** Complete a take the viewer holds: assignee, `claimed`, and no `paused` on open pull requests. */
  const settleTake = Effect.fn("LeaseService.settleTake")(function* (
    ref: IssueRef,
    viewer: string,
  ) {
    const assigned = yield* attempt(assignHolder(ref, viewer));
    if (assigned !== null) {
      return yield* result(ref, "incomplete", `Assigning you failed: ${assigned}`);
    }
    const unpaused = yield* attempt(setPaused(ref, false));
    if (unpaused !== null) {
      return yield* result(
        ref,
        "taken",
        `Taken, but removing paused from the pull request failed: ${unpaused} Finish retries it.`,
      );
    }
    return yield* result(ref, "taken");
  });

  /** Withdraw the viewer's standing claim with a system reason, then unassign them. */
  const withdrawClaim = Effect.fn("LeaseService.withdrawClaim")(function* (
    ref: IssueRef,
    viewer: string,
    line: string,
    keepClaimedLabel: boolean,
    outcome: "lost" | "withdrawn",
    detail?: string,
  ) {
    const posted = yield* attempt(comment(ref, line));
    if (posted !== null) {
      // Losing a race happens after the claim and assignment are written, so it never fails silently.
      if (outcome === "lost") {
        return yield* result(
          ref,
          "incomplete",
          `${detail ?? "Someone else claimed first."} Withdrawing your claim failed: ${posted}`,
        );
      }
      return yield* new TaskLeaseError({ reason: "failed", detail: posted });
    }
    const unassigned = yield* attempt(
      reconcile(ref, (current) => ({
        assignees: withoutName(current.assignees, viewer),
        labels: keepClaimedLabel
          ? current.labels
          : withoutName(current.labels, LEASE_LABEL_CLAIMED),
      })),
    );
    if (unassigned !== null) {
      return yield* result(
        ref,
        "incomplete",
        `The claim is withdrawn, but unassigning you failed: ${unassigned} Withdraw retries it.`,
      );
    }
    return yield* result(ref, outcome, detail);
  });

  const check = Effect.fn("LeaseService.check")(function* (input: IssueRef) {
    const ref = issueRefOf(input);
    return statusOf(yield* read(ref), ref);
  });

  const take: LeaseServiceShape["take"] = (input) => {
    const ref = issueRefOf(input);
    return exclusive(
      ref,
      "take",
      Effect.gen(function* () {
        const before = yield* read(ref);
        const viewer = yield* requireAvailable(before);
        const lease = before.fold.lease;
        if (lease !== null) {
          if (lease.claimants[0] !== undefined && same(lease.claimants[0], viewer)) {
            return lease.state === "incomplete"
              ? yield* settleTake(ref, viewer)
              : yield* result(ref, "taken");
          }
          return yield* new TaskLeaseError({
            reason: "refused",
            detail: same(lease.holder, viewer)
              ? "Your earlier take did not finish. Finish or withdraw it first."
              : lease.claimants.some((login) => same(login, viewer))
                ? "You already claimed it. Withdraw first."
                : `${lease.holder} holds this task.`,
          });
        }
        yield* comment(ref, formatClaimLine(viewer, input.agent ?? "hub")).pipe(
          Effect.mapError(failed),
        );
        const assigned = yield* attempt(assignHolder(ref, viewer));
        if (assigned !== null) {
          const withdrawn = yield* attempt(comment(ref, formatWithdrawLine("take_failed")));
          return withdrawn === null
            ? yield* result(
                ref,
                "withdrawn",
                `Assigning you failed, so the take was withdrawn: ${assigned}`,
              )
            : yield* result(
                ref,
                "incomplete",
                `Assigning you failed and the take could not be withdrawn: ${withdrawn}`,
              );
        }
        // Two people may take at once: the earliest claim wins, so wait for both to land and read again.
        if (Duration.toMillis(Duration.fromInputUnsafe(readBackDelay)) > 0) {
          yield* Effect.sleep(readBackDelay);
        }
        const after = yield* read(ref);
        const claimants = after.fold.lease?.claimants ?? [];
        const position = claimants.findIndex((login) => same(login, viewer));
        if (position === 0) return yield* settleTake(ref, viewer);
        if (position < 0) {
          return yield* result(
            ref,
            "incomplete",
            "Your claim does not show on the tracker. Withdraw to undo the assignment.",
          );
        }
        const winner = claimants[0] ?? "";
        return yield* withdrawClaim(
          ref,
          viewer,
          formatWithdrawLine("lost_claim", `@${winner}`),
          true,
          "lost",
          `${winner} took it first.`,
        );
      }),
    );
  };

  const release: LeaseServiceShape["release"] = (input) => {
    const ref = issueRefOf(input);
    const written = {
      reason: input.reason,
      reasonText: input.reasonText,
      freeToContinue: input.freeToContinue,
      note: input.note,
      followUps: input.followUps,
    };
    return exclusive(
      ref,
      "release",
      Effect.gen(function* () {
        const invalid = checkReleaseComment(written);
        if (invalid !== null)
          return yield* new TaskLeaseError({ reason: "invalid", detail: invalid });
        const before = yield* read(ref);
        const viewer = yield* requireAvailable(before);
        const claimants = before.fold.lease?.claimants ?? [];
        if (claimants[0] !== undefined && same(claimants[0], viewer)) {
          yield* comment(ref, formatReleaseComment(written)).pipe(Effect.mapError(failed));
          return yield* settleRelease(ref, viewer, claimants.length > 1);
        }
        // A retry of a release whose comment already landed: finish it without a second comment.
        if (ownRelease(before) !== null)
          return yield* settleRelease(ref, viewer, claimants.length > 0);
        return yield* new TaskLeaseError({
          reason: "refused",
          detail: "You do not hold this task.",
        });
      }),
    );
  };

  const finish: LeaseServiceShape["finish"] = (input) => {
    const ref = issueRefOf(input);
    return exclusive(
      ref,
      "finish",
      Effect.gen(function* () {
        const before = yield* read(ref);
        const viewer = yield* requireAvailable(before);
        const claimants = before.fold.lease?.claimants ?? [];
        if (claimants[0] !== undefined && same(claimants[0], viewer)) {
          return yield* settleTake(ref, viewer);
        }
        if (claimants.length === 0 && ownRelease(before) !== null) {
          return yield* settleRelease(ref, viewer, false);
        }
        return yield* new TaskLeaseError({
          reason: "refused",
          detail: "Nothing of yours is unfinished on this task.",
        });
      }),
    );
  };

  const withdraw: LeaseServiceShape["withdraw"] = (input) => {
    const ref = issueRefOf(input);
    return exclusive(
      ref,
      "withdraw",
      Effect.gen(function* () {
        const before = yield* read(ref);
        const viewer = yield* requireAvailable(before);
        const lease = before.fold.lease;
        const claimants = lease?.claimants ?? [];
        const position = claimants.findIndex((login) => same(login, viewer));
        if (position === 0) {
          if (lease?.state !== "incomplete") {
            return yield* new TaskLeaseError({
              reason: "refused",
              detail: "You hold this task. Release it instead.",
            });
          }
          return yield* withdrawClaim(
            ref,
            viewer,
            formatWithdrawLine("take_failed"),
            claimants.length > 1,
            "withdrawn",
          );
        }
        if (position > 0) {
          return yield* withdrawClaim(
            ref,
            viewer,
            formatWithdrawLine("lost_claim", `@${claimants[0] ?? ""}`),
            true,
            "withdrawn",
          );
        }
        // No claim of the viewer's stands, but the tracker still names them: clear what is left.
        if (lease !== null && lease.state === "incomplete" && same(lease.holder, viewer)) {
          const cleared = yield* attempt(
            reconcile(ref, (current) => ({
              assignees: withoutName(current.assignees, viewer),
              labels: withoutName(current.labels, LEASE_LABEL_CLAIMED),
            })),
          );
          if (cleared !== null) {
            return yield* new TaskLeaseError({ reason: "failed", detail: cleared });
          }
          return yield* result(ref, "withdrawn");
        }
        return yield* new TaskLeaseError({
          reason: "refused",
          detail: "Nothing of yours is unfinished on this task.",
        });
      }),
    );
  };

  return { check, take, release, finish, withdraw } satisfies LeaseServiceShape;
});

export const layerWith = (options: Partial<LeaseServiceOptions>) =>
  Layer.effect(LeaseService, make(options));

export const layer = layerWith({});

/** Handlers for the lease RPCs, spread into the WebSocket handler group. */
export const rpcHandlers = {
  [TASK_LEASE_WS_METHODS.check]: Effect.fn("LeaseService.rpc.check")(function* (input: IssueRef) {
    return yield* (yield* LeaseService).check(input);
  }),
  [TASK_LEASE_WS_METHODS.take]: Effect.fn("LeaseService.rpc.take")(function* (
    input: TaskLeaseTakeInput,
  ) {
    return yield* (yield* LeaseService).take(input);
  }),
  [TASK_LEASE_WS_METHODS.release]: Effect.fn("LeaseService.rpc.release")(function* (
    input: TaskLeaseReleaseInput,
  ) {
    return yield* (yield* LeaseService).release(input);
  }),
  [TASK_LEASE_WS_METHODS.finish]: Effect.fn("LeaseService.rpc.finish")(function* (input: IssueRef) {
    return yield* (yield* LeaseService).finish(input);
  }),
  [TASK_LEASE_WS_METHODS.withdraw]: Effect.fn("LeaseService.rpc.withdraw")(function* (
    input: IssueRef,
  ) {
    return yield* (yield* LeaseService).withdraw(input);
  }),
};
