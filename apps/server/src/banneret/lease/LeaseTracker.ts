import type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";
import { IssueOperationError, type TaskLeaseRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SourceControlDrivers } from "../../sourceControl/builtInDrivers.ts";
import type { IssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";

export type LeaseIssue = Omit<TaskLeaseRef, "relayOrigin">;

export function repositoryTracker(
  api: IssueTrackerApi | undefined,
  prs?: Pick<
    PullRequestProviderApi,
    "getChangeRequest" | "withVerifiedCredential" | "setLabels"
  > | null,
) {
  const target = Effect.fn("LeaseTracker.target")(function* (ref: LeaseIssue) {
    if (
      !api ||
      ref.tracker !== "github" ||
      !/^[\w.-]+\/[\w.-]+$/.test(ref.scope) ||
      !/^[1-9]\d*$/.test(ref.key)
    ) {
      return yield* new IssueOperationError({
        operation: "lease",
        detail: "The task needs a GitHub repository and issue number.",
      });
    }
    return {
      api,
      target: { cwd: "/", host: ref.host ?? "github.com", scope: ref.scope, key: ref.key },
    };
  });
  return {
    detail: Effect.fn(function* (ref: LeaseIssue) {
      const { api, target: issue } = yield* target(ref);
      const detail = yield* api.getIssue(issue);
      return {
        ...detail,
        tracker: api.kind,
        host: issue.host,
        scope: issue.scope,
        capabilities: api.capabilities,
      };
    }),
    pausePullRequest: Effect.fn(function* (
      ref: LeaseIssue,
      repository: string,
      number: number,
      viewer: string,
      applied: boolean,
    ) {
      const pr = { cwd: "/", host: ref.host ?? "github.com", repository, number };
      const setLabels = prs?.setLabels;
      if (!prs?.withVerifiedCredential || !setLabels)
        return yield* new IssueOperationError({
          operation: "lease",
          detail: "Pull request labels are unavailable.",
        });
      yield* prs.withVerifiedCredential(pr, (identity) =>
        Effect.gen(function* () {
          if (identity.viewer.toLowerCase() !== viewer.toLowerCase())
            return yield* new IssueOperationError({
              operation: "lease",
              detail: `The pull request account is ${identity.viewer}. The lease holder is ${viewer}.`,
            });
          const current = yield* prs.getChangeRequest(pr);
          if (current.state !== "open" || (applied && !current.isDraft)) return;
          if (current.labels.some((label) => label.name.toLowerCase() === "paused") !== applied)
            yield* setLabels({ ...pr, labels: ["paused"], applied });
        }),
      );
    }),
    comments: Effect.fn(function* (ref: LeaseIssue & { cursor: string }) {
      const { api, target: issue } = yield* target(ref);
      return yield* api.getComments({ ...issue, cursor: ref.cursor });
    }),
    comment: Effect.fn(function* (ref: LeaseIssue & { body: string }) {
      const { api, target: issue } = yield* target(ref);
      if (!api.comment)
        return yield* new IssueOperationError({
          operation: "lease",
          detail: "Comments are unavailable.",
        });
      yield* api.comment({ ...issue, body: ref.body });
    }),
    update: Effect.fn(function* (
      ref: LeaseIssue & { labels?: ReadonlyArray<string>; assignees?: ReadonlyArray<string> },
    ) {
      const { api, target: issue } = yield* target(ref);
      if (!api.update)
        return yield* new IssueOperationError({
          operation: "lease",
          detail: "Issue updates are unavailable.",
        });
      yield* api.update({ ...issue, labels: ref.labels, assignees: ref.assignees });
    }),
  };
}

export class LeaseTracker extends Context.Service<
  LeaseTracker,
  ReturnType<typeof repositoryTracker>
>()("t3/banneret/lease/LeaseTracker") {}
export const layer = Layer.effect(
  LeaseTracker,
  Effect.map(SourceControlDrivers, (drivers) => {
    const github = drivers.find((entry) => entry.driver.kind === "github")?.instance;
    return repositoryTracker(github?.issues, github?.pullRequests);
  }),
);
