// Banneret Hub: when GitHub issue comments were written and last edited, so the lease fold can
// ignore an edited `claim:` or `release:` comment. Reads through the driver's own GitHubRest, so
// it spends the same credential and quota as the issue tracker. The server reads it as the
// driver instance's `banneretCommentEdits` (apps/server/src/banneret/lease/CommentEdits.ts).
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GitHubRest from "./GitHubRest.ts";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const COMMENT_ID = /^[1-9]\d{0,19}$/;

class BanneretCommentEditsError extends Schema.TaggedError<BanneretCommentEditsError>()(
  "BanneretCommentEditsError",
  { message: Schema.String },
) {}

const decodeComment = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ created_at: Schema.String, updated_at: Schema.String })),
);

export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  /** Comment database id to its REST `created_at` and `updated_at`. Any failure, a 404 included, fails the read. */
  return Effect.fn("GitHubDriver.banneretCommentEdits")(function* (input: {
    readonly host: string;
    readonly repository: string;
    readonly commentIds: ReadonlyArray<string>;
  }) {
    if (!REPOSITORY.test(input.repository) || input.commentIds.some((id) => !COMMENT_ID.test(id))) {
      return yield* new BanneretCommentEditsError({
        message: "A comment was named that GitHub cannot address.",
      });
    }
    const times = new Map<string, { readonly createdAt: string; readonly updatedAt: string }>();
    for (const id of input.commentIds) {
      const response = yield* api.rest({
        host: input.host,
        operation: "getIssueComment",
        path: `repos/${input.repository}/issues/comments/${id}`,
      });
      const comment = yield* decodeComment(response.body);
      times.set(id, { createdAt: comment.created_at, updatedAt: comment.updated_at });
    }
    return times;
  });
});
