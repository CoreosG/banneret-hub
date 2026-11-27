// @effect-diagnostics globalDate:off globalDateInEffect:off - the fake tracker writes ISO comment times.
import {
  type IssueComment,
  type IssueDetail,
  type IssueRef,
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueService from "../../issue/IssueService.ts";
import type { IssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import { LeaseTracker, repositoryTracker } from "./LeaseTracker.ts";
import * as BanneretEnrolment from "../relay/Enrolment.ts";
import * as CommentEdits from "./CommentEdits.ts";
import * as LeaseService from "./LeaseService.ts";

// An in-memory issue behind the issue and pull request services: the boundary LeaseService writes through.
// Nothing here reaches a real tracker.

export const ME = "ada-example";
export const OTHER = "bo-example";
const PAGE = 3;
/** Every test starts its TestClock here. */
export const EPOCH = Date.UTC(2026, 10, 20, 10);

export const ref = {
  relayOrigin: "https://relay.example",
  tracker: IssueTrackerKind.make("github"),
  scope: "example-org/example-app",
  key: "7",
};

export interface FakeTracker {
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

export const newTracker = (overrides: Partial<FakeTracker> = {}): FakeTracker => ({
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

export const addComment = (tracker: FakeTracker, author: string, body: string, ageSeconds = 0) =>
  addCommentAt(tracker, author, body, EPOCH - ageSeconds * 1000);

export const addCommentAt = (
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

const fakeIssue = (tracker: FakeTracker) => ({
  detail: () =>
    Effect.sync(() => {
      // Newest page first, older pages behind a cursor, as GitHub serves them.
      const ordered = [...tracker.comments];
      const page = ordered.slice(-PAGE);
      return {
        scope: ref.scope,
        url: "https://github.com/" + ref.scope + "/issues/" + ref.key,
        title: "Test task",
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
  linkMetadata: (input: IssueRef) =>
    Effect.succeed({
      title: `Issue ${input.key}`,
      url: `https://github.com/${input.scope}/issues/${input.key}`,
      displayKey: `#${input.key}`,
    }),
  // A GitHub issue URL resolves through the preferred project, as on a machine with a checkout of it.
  resolveUrl: (url: string, preferredProjectId?: ProjectId) =>
    Effect.suspend(() => {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
      if (match === null) return refused("resolveUrl");
      return Effect.succeed({
        projectId: preferredProjectId ?? ProjectId.make("project-1"),
        tracker: ref.tracker,
        host: "github.com",
        scope: match[1]!,
        key: match[2]!,
        writable: true,
      });
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
});

export const issueService = (tracker: FakeTracker) =>
  fakeIssue(tracker) as unknown as IssueService.IssueService["Service"];

export const leaseTrackerLayer = (tracker: FakeTracker) => {
  const fake = fakeIssue(tracker);
  // Only the driver is stubbed. A lookup through a checkout or another repository fails.
  const api = {
    kind: ref.tracker,
    capabilities: tracker.capabilities,
    getIssue: (target: { cwd: string; scope: string; key: string }) =>
      target.cwd === "/" && target.scope === ref.scope ? fake.detail() : refused("getIssue"),
    getComments: fake.comments,
    comment: fake.comment,
    update: fake.update,
  } as unknown as IssueTrackerApi;
  return Layer.succeed(LeaseTracker, repositoryTracker(api));
};

/** GitHub's REST times for the asked comments the tracker still has. */
export const commentEdits = (tracker: FakeTracker) =>
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

export const enrolledAs = (login: string, role = "limited_staff") =>
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

export const leases = (
  tracker: FakeTracker,
  enrolment: Layer.Layer<never> = enrolledAs(ME),
  readBackDelay: Duration.Input = 0,
) =>
  Effect.service(LeaseService.LeaseService).pipe(
    Effect.provide(
      LeaseService.layerWith({ readBackDelay }).pipe(
        Layer.provide(
          Layer.mergeAll(
            leaseTrackerLayer(tracker),
            Layer.succeed(CommentEdits.CommentEdits, commentEdits(tracker)),
            enrolment,
          ),
        ),
      ),
    ),
  );
