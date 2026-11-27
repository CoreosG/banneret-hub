// When protocol comments were last edited, for the lease fold: an edited `claim:` or `release:`
// counts for nothing (docs/banneret/relay-v1/README.md, "Lease protocol"). Upstream's issue comments
// carry no edit time, so GitHub's comes from the driver's `banneretCommentEdits`
// (packages/source-control-github/src/server/banneretCommentEdits.ts). Other trackers report none.
import type { IssueTrackerKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as BuiltInDrivers from "../../sourceControl/builtInDrivers.ts";

interface CommentTimes {
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The GitHub driver's hook, as packages/source-control-github/src/server/driver.ts adds it. */
type GitHubCommentEdits = (input: {
  readonly host: string;
  readonly repository: string;
  readonly commentIds: ReadonlyArray<string>;
}) => Effect.Effect<ReadonlyMap<string, CommentTimes>, { readonly _tag: string }>;

export class CommentEditsError extends Schema.TaggedError<CommentEditsError>()(
  "CommentEditsError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface CommentEditsShape {
  /**
   * Comment id to its edit times, or null when the tracker reports none (every comment then reads as
   * unedited).
   */
  readonly read: (input: {
    readonly tracker: IssueTrackerKind;
    readonly host: string;
    readonly scope: string;
    readonly commentIds: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyMap<string, CommentTimes> | null, CommentEditsError>;
}

export class CommentEdits extends Context.Service<CommentEdits, CommentEditsShape>()(
  "t3/banneret/lease/CommentEdits",
) {}

const GITHUB = "github";

const make = Effect.gen(function* () {
  const drivers = yield* BuiltInDrivers.SourceControlDrivers;
  const instance = drivers.find(({ driver }) => driver.kind === GITHUB)?.instance as
    | { readonly banneretCommentEdits?: GitHubCommentEdits }
    | undefined;
  const gitHub = instance?.banneretCommentEdits;
  return CommentEdits.of({
    read: Effect.fn("CommentEdits.read")(function* (input) {
      if (input.tracker !== GITHUB) return null;
      // Without the hook a GitHub lease cannot be read safely, so the read fails rather than skip the rule.
      if (gitHub === undefined) {
        return yield* new CommentEditsError({
          message: "The GitHub driver cannot say when comments were edited.",
        });
      }
      if (input.commentIds.length === 0) return new Map();
      return yield* gitHub({
        host: input.host,
        repository: input.scope,
        commentIds: input.commentIds,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new CommentEditsError({
              message: "GitHub would not say when the lease comments were edited.",
              cause,
            }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(CommentEdits, make);
