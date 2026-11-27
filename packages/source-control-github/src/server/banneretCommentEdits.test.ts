import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as BanneretCommentEdits from "./banneretCommentEdits.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

describe("banneretCommentEdits", () => {
  it.effect("reads each comment's REST times and fails on one GitHub no longer has", () => {
    const paths: Array<string> = [];
    const api = Layer.mock(GitHubRest.GitHubRest)({
      rest: (input) => {
        paths.push(input.path);
        return input.path.endsWith("/11")
          ? Effect.succeed({
              status: 200,
              headers: {},
              body: JSON.stringify({
                id: 11,
                created_at: "2026-11-20T10:00:00Z",
                updated_at: "2026-11-20T10:05:00Z",
              }),
              truncated: false,
              invalidUtf8: false,
            })
          : Effect.fail(
              new GitHubRequestPolicy.GitHubApiNotFoundError({
                host: input.host,
                operation: input.operation,
              }),
            );
      },
    });
    return Effect.gen(function* () {
      const read = yield* BanneretCommentEdits.make;
      const times = yield* read({
        host: "github.com",
        repository: "example-org/example-app",
        commentIds: ["11"],
      });
      assert.deepStrictEqual(
        [...times],
        [["11", { createdAt: "2026-11-20T10:00:00Z", updatedAt: "2026-11-20T10:05:00Z" }]],
      );
      const deleted = yield* Effect.exit(
        read({ host: "github.com", repository: "example-org/example-app", commentIds: ["12"] }),
      );
      assert.isTrue(Exit.isFailure(deleted));
      assert.deepStrictEqual(paths, [
        "repos/example-org/example-app/issues/comments/11",
        "repos/example-org/example-app/issues/comments/12",
      ]);
      const refused = yield* Effect.exit(
        read({ host: "github.com", repository: "../repos", commentIds: ["11"] }),
      );
      assert.isTrue(Exit.isFailure(refused));
      assert.strictEqual(paths.length, 2);
    }).pipe(Effect.provide(api));
  });
});
